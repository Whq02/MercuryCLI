
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi::Task;
use napi_derive::napi;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

static MODELS: OnceLock<Mutex<HashMap<u32, Arc<WhisperContext>>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

fn models() -> &'static Mutex<HashMap<u32, Arc<WhisperContext>>> {
    MODELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn quiet() {
    whisper_rs::install_logging_hooks();
}

fn model(handle: u32) -> Result<Arc<WhisperContext>> {
    let map = match models().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.get(&handle)
        .cloned()
        .ok_or_else(|| Error::from_reason(format!("no loaded model with handle {handle}")))
}

#[napi]
pub fn pack_version() -> String {
    quiet();
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn engine_version() -> String {
    quiet();
    whisper_rs::get_whisper_version().to_string()
}

#[napi]
pub fn system_info() -> String {
    quiet();
    whisper_rs::print_system_info().to_string()
}

#[napi(object)]
pub struct CpuFloorAnswer {
    pub arch: String,
    pub floor: String,
    pub met: bool,
    pub missing: Vec<String>,
}

#[napi]
pub fn cpu_floor() -> CpuFloorAnswer {
    #[cfg(target_arch = "x86_64")]
    {
        let mut missing: Vec<String> = Vec::new();
        if !std::arch::is_x86_feature_detected!("avx2") {
            missing.push("avx2".to_string());
        }
        if !std::arch::is_x86_feature_detected!("fma") {
            missing.push("fma".to_string());
        }
        if !std::arch::is_x86_feature_detected!("f16c") {
            missing.push("f16c".to_string());
        }
        CpuFloorAnswer {
            arch: "x86_64".to_string(),
            floor: "AVX2, FMA and F16C".to_string(),
            met: missing.is_empty(),
            missing,
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        CpuFloorAnswer {
            arch: "aarch64".to_string(),
            floor: "NEON".to_string(),
            met: true,
            missing: Vec::new(),
        }
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        CpuFloorAnswer {
            arch: std::env::consts::ARCH.to_string(),
            floor: "the architecture baseline".to_string(),
            met: true,
            missing: Vec::new(),
        }
    }
}

#[napi]
pub fn load_model(path: String, use_gpu: Option<bool>) -> Result<u32> {
    quiet();
    let mut params = WhisperContextParameters::default();
    params.use_gpu(use_gpu.unwrap_or(true));
    let ctx = WhisperContext::new_with_params(&path, params).map_err(|error| {
        Error::from_reason(format!("the model at {path} could not be loaded: {error}"))
    })?;
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);
    let mut map = match models().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.insert(handle, Arc::new(ctx));
    Ok(handle)
}

#[napi(object)]
pub struct ModelInfo {
    pub multilingual: bool,
    pub kind: String,
}

#[napi]
pub fn model_info(handle: u32) -> Result<ModelInfo> {
    let ctx = model(handle)?;
    let kind = ctx
        .model_type_readable_str_lossy()
        .map(|s| s.into_owned())
        .unwrap_or_default();
    Ok(ModelInfo {
        multilingual: ctx.is_multilingual(),
        kind,
    })
}

#[napi]
pub fn unload_model(handle: u32) -> Result<()> {
    let mut map = match models().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.remove(&handle)
        .map(|_| ())
        .ok_or_else(|| Error::from_reason(format!("no loaded model with handle {handle}")))
}

#[napi(object)]
#[derive(Default)]
pub struct TranscribeOptions {
    pub language: Option<String>,
    pub threads: Option<u32>,
    pub prompt: Option<String>,
}

#[napi(object)]
pub struct TranscriptAnswer {
    pub text: String,
    pub ms: u32,
    pub language: String,
    pub segments: u32,
}

pub struct TranscribeTask {
    ctx: Arc<WhisperContext>,
    samples: Vec<f32>,
    language: Option<String>,
    threads: i32,
    prompt: Option<String>,
}

fn tidy(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Task for TranscribeTask {
    type Output = TranscriptAnswer;
    type JsValue = TranscriptAnswer;

    fn compute(&mut self) -> Result<TranscriptAnswer> {
        let started = Instant::now();
        let mut state = self.ctx.create_state().map_err(|error| {
            Error::from_reason(format!(
                "whisper.cpp could not open a decoding state: {error}"
            ))
        })?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.threads);
        params.set_translate(false);
        params.set_language(self.language.as_deref());
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        if let Some(prompt) = self.prompt.as_deref() {
            if !prompt.trim().is_empty() {
                params.set_initial_prompt(prompt);
            }
        }
        state.full(params, &self.samples).map_err(|error| {
            Error::from_reason(format!("whisper.cpp could not decode the take: {error}"))
        })?;
        let mut text = String::new();
        let mut segments = 0u32;
        for segment in state.as_iter() {
            let piece = segment.to_str_lossy().map_err(|error| {
                Error::from_reason(format!(
                    "whisper.cpp answered an unreadable segment: {error}"
                ))
            })?;
            text.push(' ');
            text.push_str(&piece);
            segments += 1;
        }
        let language = whisper_rs::get_lang_str(state.full_lang_id_from_state())
            .unwrap_or("")
            .to_string();
        let ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
        Ok(TranscriptAnswer {
            text: tidy(&text),
            ms,
            language,
            segments,
        })
    }

    fn resolve(&mut self, _env: Env, output: TranscriptAnswer) -> Result<TranscriptAnswer> {
        Ok(output)
    }
}

fn default_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 4) as i32
}

#[napi(ts_return_type = "Promise<TranscriptAnswer>")]
pub fn transcribe(
    handle: u32,
    pcm: Buffer,
    options: Option<TranscribeOptions>,
) -> Result<AsyncTask<TranscribeTask>> {
    let ctx = model(handle)?;
    let bytes: &[u8] = pcm.as_ref();
    let count = bytes.len() / 2;
    if count == 0 {
        return Err(Error::from_reason("the take carries no samples"));
    }
    let mut samples: Vec<f32> = Vec::with_capacity(count);
    for pair in bytes.chunks_exact(2) {
        samples.push(i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0);
    }
    let options = options.unwrap_or_default();
    let threads = options
        .threads
        .map(|t| t.clamp(1, 16) as i32)
        .unwrap_or_else(default_threads);
    let language = options.language.filter(|l| !l.trim().is_empty());
    Ok(AsyncTask::new(TranscribeTask {
        ctx,
        samples,
        language,
        threads,
        prompt: options.prompt,
    }))
}
