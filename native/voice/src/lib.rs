//! Mercury's voice capture addon — a Node-API module over cpal.
//!
//! Surface (camelCase on the JS side):
//!   packVersion()            the crate version
//!   listInputDevices()       every input device name the host reports
//!   defaultInputDevice()     the default input's name, or null
//!   startCapture()           open a take on the default input → handle
//!   stopCapture(handle)      close the take → its bytes as s16le 16 kHz mono
//!   cancelCapture(handle)    close the take, keep nothing
//!
//! A take runs on its own thread (an audio stream is bound to the thread
//! that built it): the thread builds the stream, plays it, waits for the
//! stop signal and drops it. Samples arrive at the device's own rate and
//! channel count, are folded to mono as they arrive, and are resampled to
//! 16 kHz when the take closes. Nothing is written anywhere.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// The capture format Mercury's transcribers are promised.
const TARGET_RATE: u32 = 16_000;

struct Take {
    stop: Sender<()>,
    /// Mono samples at the device rate, folded as they arrive.
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    thread: JoinHandle<()>,
}

static TAKES: OnceLock<Mutex<HashMap<u32, Take>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

fn takes() -> &'static Mutex<HashMap<u32, Take>> {
    TAKES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[napi]
pub fn pack_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    match host.input_devices() {
        Ok(devices) => devices.filter_map(|device| device_name(&device)).collect(),
        Err(_) => Vec::new(),
    }
}

#[napi]
pub fn default_input_device() -> Option<String> {
    cpal::default_host()
        .default_input_device()
        .and_then(|device| device_name(&device))
}

fn device_name(device: &cpal::Device) -> Option<String> {
    device
        .description()
        .ok()
        .map(|description| description.name().to_string())
}

/// Fold one interleaved buffer into the mono sink.
fn push_samples<T>(sink: &Arc<Mutex<Vec<f32>>>, data: &[T], channels: usize)
where
    T: cpal::Sample,
    f32: cpal::FromSample<T>,
{
    let channels = channels.max(1);
    let mut guard = match sink.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for frame in data.chunks(channels) {
        let mut acc = 0.0f32;
        for sample in frame {
            acc += f32::from_sample(*sample);
        }
        guard.push(acc / frame.len() as f32);
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sink: Arc<Mutex<Vec<f32>>>,
    channels: usize,
) -> std::result::Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    device
        .build_input_stream(
            config.clone(),
            move |data: &[T], _: &cpal::InputCallbackInfo| push_samples(&sink, data, channels),
            |error| eprintln!("mercury_voice: input stream error: {error}"),
            None,
        )
        .map_err(|error| error.to_string())
}

#[napi]
pub fn start_capture() -> Result<u32> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| Error::from_reason("no default input device"))?;
    let supported = device
        .default_input_config()
        .map_err(|error| Error::from_reason(format!("no default input config: {error}")))?;
    let rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = samples.clone();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<std::result::Result<(), String>>();
    let thread = std::thread::spawn(move || {
        let built = match sample_format {
            cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, sink, channels),
            cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, sink, channels),
            cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, sink, channels),
            cpal::SampleFormat::I32 => build_stream::<i32>(&device, &config, sink, channels),
            cpal::SampleFormat::U8 => build_stream::<u8>(&device, &config, sink, channels),
            other => Err(format!("unsupported input sample format {other:?}")),
        };
        let stream = match built {
            Ok(stream) => stream,
            Err(reason) => {
                let _ = ready_tx.send(Err(reason));
                return;
            }
        };
        if let Err(error) = stream.play() {
            let _ = ready_tx.send(Err(format!("the input stream would not start: {error}")));
            return;
        }
        let _ = ready_tx.send(Ok(()));
        // Hold the stream until the take closes; a dropped sender ends it too.
        let _ = stop_rx.recv();
        drop(stream);
    });
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(reason)) => {
            let _ = thread.join();
            return Err(Error::from_reason(reason));
        }
        Err(_) => {
            let _ = thread.join();
            return Err(Error::from_reason(
                "the capture thread ended before the input stream started",
            ));
        }
    }
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);
    let mut map = match takes().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.insert(
        handle,
        Take {
            stop: stop_tx,
            samples,
            rate,
            thread,
        },
    );
    Ok(handle)
}

fn close_take(handle: u32) -> Result<Take> {
    let take = {
        let mut map = match takes().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        map.remove(&handle)
    }
    .ok_or_else(|| Error::from_reason(format!("no capture with handle {handle}")))?;
    let _ = take.stop.send(());
    Ok(take)
}

fn clamp_i16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

/// Linear resampling of mono samples to the target rate.
fn resample_to_i16(mono: &[f32], from: u32, to: u32) -> Vec<i16> {
    if mono.is_empty() {
        return Vec::new();
    }
    if from == to || from == 0 {
        return mono.iter().map(|value| clamp_i16(*value)).collect();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let position = i as f64 * ratio;
        let index = position.floor() as usize;
        let fraction = (position - index as f64) as f32;
        let a = mono[index.min(mono.len() - 1)];
        let b = mono[(index + 1).min(mono.len() - 1)];
        out.push(clamp_i16(a + (b - a) * fraction));
    }
    out
}

#[napi]
pub fn stop_capture(handle: u32) -> Result<Buffer> {
    let take = close_take(handle)?;
    let Take {
        samples, rate, thread, ..
    } = take;
    let _ = thread.join();
    let mono = match samples.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    let pcm = resample_to_i16(&mono, rate, TARGET_RATE);
    let mut bytes = Vec::with_capacity(pcm.len() * 2);
    for sample in pcm {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(Buffer::from(bytes))
}

#[napi]
pub fn cancel_capture(handle: u32) -> Result<()> {
    let take = close_take(handle)?;
    let _ = take.thread.join();
    Ok(())
}
