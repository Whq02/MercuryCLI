use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;

#[cfg(target_os = "macos")]
#[link(name = "Accelerate", kind = "framework")]
extern "C" {
    fn cblas_sgemm(
        order: i32,
        trans_a: i32,
        trans_b: i32,
        m: i32,
        n: i32,
        k: i32,
        alpha: f32,
        a: *const f32,
        lda: i32,
        b: *const f32,
        ldb: i32,
        beta: f32,
        c: *mut f32,
        ldc: i32,
    );
}

fn sgemm_nt(m: usize, n: usize, k: usize, a: &[f32], b: &[f32], c: &mut [f32]) {
    #[cfg(target_os = "macos")]
    unsafe {
        cblas_sgemm(
            101,
            111,
            112,
            m as i32,
            n as i32,
            k as i32,
            1.0,
            a.as_ptr(),
            k as i32,
            b.as_ptr(),
            k as i32,
            0.0,
            c.as_mut_ptr(),
            n as i32,
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        for i in 0..m {
            let a_row = &a[i * k..(i + 1) * k];
            let c_row = &mut c[i * n..(i + 1) * n];
            for j in 0..n {
                let b_row = &b[j * k..(j + 1) * k];
                let mut sum = 0.0f32;
                for p in 0..k {
                    sum += a_row[p] * b_row[p];
                }
                c_row[j] = sum;
            }
        }
    }
}

fn f16_to_f32(h: u16) -> f32 {
    let s = ((h & 0x8000) as u32) << 16;
    let e = ((h >> 10) & 0x1f) as i32;
    let m = (h & 0x03ff) as u32;
    if e == 0 {
        if m == 0 {
            return f32::from_bits(s);
        }
        let mut mm = m;
        let mut ee = -14i32;
        while (mm & 0x0400) == 0 {
            mm <<= 1;
            ee -= 1;
        }
        mm &= 0x03ff;
        let bits = s | (((ee + 127) as u32) << 23) | (mm << 13);
        return f32::from_bits(bits);
    }
    if e == 31 {
        return f32::from_bits(s | 0x7f800000 | (m << 13));
    }
    let bits = s | (((e - 15 + 127) as u32) << 23) | (m << 13);
    f32::from_bits(bits)
}

enum BlockWeights {
    Bert {
        q_w: Vec<f32>,
        q_b: Vec<f32>,
        k_w: Vec<f32>,
        k_b: Vec<f32>,
        v_w: Vec<f32>,
        v_b: Vec<f32>,
        out_w: Vec<f32>,
        out_b: Vec<f32>,
        attn_norm_w: Vec<f32>,
        attn_norm_b: Vec<f32>,
        up_w: Vec<f32>,
        up_b: Vec<f32>,
        down_w: Vec<f32>,
        down_b: Vec<f32>,
        ffn_norm_w: Vec<f32>,
        ffn_norm_b: Vec<f32>,
    },
    NomicBert {
        qkv_w: Vec<f32>,
        out_w: Vec<f32>,
        attn_norm_w: Vec<f32>,
        attn_norm_b: Vec<f32>,
        up_w: Vec<f32>,
        gate_w: Vec<f32>,
        down_w: Vec<f32>,
        ffn_norm_w: Vec<f32>,
        ffn_norm_b: Vec<f32>,
    },
}

struct EmbedModel {
    name: String,
    arch: String,
    d_model: usize,
    d_ffn: usize,
    n_head: usize,
    n_layer: usize,
    eps: f32,
    pool_type: u32,
    rope_base: f32,
    cls_id: usize,
    sep_id: usize,
    unk_id: usize,
    vocab: HashMap<String, usize>,
    tok_embd: Vec<f32>,
    pos_embd: Option<Vec<f32>>,
    type_embd: Option<Vec<f32>>,
    embd_norm_w: Vec<f32>,
    embd_norm_b: Vec<f32>,
    blocks: Vec<BlockWeights>,
}

#[derive(Clone)]
enum KvVal {
    U32(u32),
    F32(f32),
    Str(String),
    StrArr(Vec<String>),
    Other,
}

struct TensorMeta {
    dims: Vec<usize>,
    ttype: u32,
    offset: usize,
}

fn read_u16(b: &[u8], off: &mut usize) -> Result<u16> {
    if *off + 2 > b.len() {
        return Err(Error::from_reason("truncated gguf u16"));
    }
    let v = u16::from_le_bytes([b[*off], b[*off + 1]]);
    *off += 2;
    Ok(v)
}

fn read_u32(b: &[u8], off: &mut usize) -> Result<u32> {
    if *off + 4 > b.len() {
        return Err(Error::from_reason("truncated gguf u32"));
    }
    let v = u32::from_le_bytes([b[*off], b[*off + 1], b[*off + 2], b[*off + 3]]);
    *off += 4;
    Ok(v)
}

fn read_u64(b: &[u8], off: &mut usize) -> Result<u64> {
    if *off + 8 > b.len() {
        return Err(Error::from_reason("truncated gguf u64"));
    }
    let v = u64::from_le_bytes([
        b[*off],
        b[*off + 1],
        b[*off + 2],
        b[*off + 3],
        b[*off + 4],
        b[*off + 5],
        b[*off + 6],
        b[*off + 7],
    ]);
    *off += 8;
    Ok(v)
}

fn read_str(b: &[u8], off: &mut usize) -> Result<String> {
    let len = read_u64(b, off)? as usize;
    if *off + len > b.len() {
        return Err(Error::from_reason("truncated gguf string"));
    }
    let s = String::from_utf8_lossy(&b[*off..*off + len]).into_owned();
    *off += len;
    Ok(s)
}

fn read_kv_val(b: &[u8], off: &mut usize, vtype: u32, keep_arr: bool) -> Result<KvVal> {
    match vtype {
        0 | 1 | 7 => {
            if *off + 1 > b.len() {
                return Err(Error::from_reason("truncated gguf u8"));
            }
            let v = b[*off] as u32;
            *off += 1;
            Ok(KvVal::U32(v))
        }
        2 | 3 => {
            let v = read_u16(b, off)? as u32;
            Ok(KvVal::U32(v))
        }
        4 | 5 => {
            let v = read_u32(b, off)?;
            Ok(KvVal::U32(v))
        }
        6 => {
            let bits = read_u32(b, off)?;
            Ok(KvVal::F32(f32::from_bits(bits)))
        }
        8 => Ok(KvVal::Str(read_str(b, off)?)),
        9 => {
            let etype = read_u32(b, off)?;
            let len = read_u64(b, off)? as usize;
            if keep_arr && etype == 8 {
                let mut out = Vec::with_capacity(len);
                for _ in 0..len {
                    out.push(read_str(b, off)?);
                }
                Ok(KvVal::StrArr(out))
            } else {
                for _ in 0..len {
                    let _ = read_kv_val(b, off, etype, false)?;
                }
                Ok(KvVal::Other)
            }
        }
        10 | 11 => {
            let v = read_u64(b, off)? as u32;
            Ok(KvVal::U32(v))
        }
        12 => {
            let bits = read_u64(b, off)?;
            Ok(KvVal::F32(f64::from_bits(bits) as f32))
        }
        _ => Err(Error::from_reason(format!("unknown gguf kv type {vtype}"))),
    }
}

impl EmbedModel {
    fn from_gguf(path: &str) -> Result<Self> {
        let bytes = fs::read(path)
            .map_err(|e| Error::from_reason(format!("failed to read {path}: {e}")))?;
        if bytes.len() < 24 || &bytes[0..4] != b"GGUF" {
            return Err(Error::from_reason(format!("{path} is not a valid GGUF file")));
        }
        let mut off = 4usize;
        let version = read_u32(&bytes, &mut off)?;
        if version < 2 || version > 3 {
            return Err(Error::from_reason(format!("unsupported GGUF version {version}")));
        }
        let n_tensors = read_u64(&bytes, &mut off)? as usize;
        let n_kv = read_u64(&bytes, &mut off)? as usize;
        let mut kv = HashMap::new();
        for _ in 0..n_kv {
            let k = read_str(&bytes, &mut off)?;
            let vtype = read_u32(&bytes, &mut off)?;
            let keep = k == "tokenizer.ggml.tokens";
            let v = read_kv_val(&bytes, &mut off, vtype, keep)?;
            kv.insert(k, v);
        }
        let mut tensors = HashMap::with_capacity(n_tensors);
        for _ in 0..n_tensors {
            let name = read_str(&bytes, &mut off)?;
            let n_dims = read_u32(&bytes, &mut off)? as usize;
            let mut dims = Vec::with_capacity(n_dims);
            for _ in 0..n_dims {
                dims.push(read_u64(&bytes, &mut off)? as usize);
            }
            let ttype = read_u32(&bytes, &mut off)?;
            let t_off = read_u64(&bytes, &mut off)? as usize;
            tensors.insert(
                name,
                TensorMeta {
                    dims,
                    ttype,
                    offset: t_off,
                },
            );
        }
        let align = match kv.get("general.alignment") {
            Some(KvVal::U32(a)) if *a > 0 => *a as usize,
            _ => 32usize,
        };
        let data_start = ((off + align - 1) / align) * align;

        let get_str = |key: &str| -> Option<String> {
            match kv.get(key) {
                Some(KvVal::Str(s)) => Some(s.clone()),
                _ => None,
            }
        };
        let get_u32 = |key: &str| -> Option<u32> {
            match kv.get(key) {
                Some(KvVal::U32(v)) => Some(*v),
                _ => None,
            }
        };
        let get_f32 = |key: &str| -> Option<f32> {
            match kv.get(key) {
                Some(KvVal::F32(v)) => Some(*v),
                Some(KvVal::U32(v)) => Some(*v as f32),
                _ => None,
            }
        };

        let arch = get_str("general.architecture")
            .ok_or_else(|| Error::from_reason("GGUF missing general.architecture"))?;
        if arch != "bert" && arch != "nomic-bert" {
            return Err(Error::from_reason(format!("unsupported embedding architecture {arch}")));
        }
        let name = get_str("general.name").unwrap_or_else(|| arch.clone());
        let n_layer = get_u32(&format!("{arch}.block_count"))
            .ok_or_else(|| Error::from_reason("GGUF missing block_count"))? as usize;
        let d_model = get_u32(&format!("{arch}.embedding_length"))
            .ok_or_else(|| Error::from_reason("GGUF missing embedding_length"))? as usize;
        let d_ffn = get_u32(&format!("{arch}.feed_forward_length"))
            .ok_or_else(|| Error::from_reason("GGUF missing feed_forward_length"))? as usize;
        let n_head = get_u32(&format!("{arch}.attention.head_count"))
            .ok_or_else(|| Error::from_reason("GGUF missing attention.head_count"))? as usize;
        let eps = get_f32(&format!("{arch}.attention.layer_norm_epsilon")).unwrap_or(1e-12);
        let pool_type = get_u32(&format!("{arch}.pooling_type")).unwrap_or(1);
        let rope_base = get_f32(&format!("{arch}.rope.freq_base")).unwrap_or(1000.0);

        let cls_id = get_u32("tokenizer.ggml.cls_token_id")
            .or_else(|| get_u32("tokenizer.ggml.bos_token_id"))
            .unwrap_or(101) as usize;
        let sep_id = get_u32("tokenizer.ggml.seperator_token_id")
            .or_else(|| get_u32("tokenizer.ggml.eos_token_id"))
            .unwrap_or(102) as usize;
        let unk_id = get_u32("tokenizer.ggml.unknown_token_id").unwrap_or(100) as usize;

        let tokens = match kv.remove("tokenizer.ggml.tokens") {
            Some(KvVal::StrArr(arr)) => arr,
            _ => return Err(Error::from_reason("GGUF missing tokenizer.ggml.tokens")),
        };
        let mut vocab = HashMap::with_capacity(tokens.len());
        for (idx, tok) in tokens.into_iter().enumerate() {
            vocab.insert(tok, idx);
        }

        let decode_tensor = |tname: &str, required: bool| -> Result<Option<Vec<f32>>> {
            let meta = match tensors.get(tname) {
                Some(m) => m,
                None => {
                    if required {
                        return Err(Error::from_reason(format!("GGUF missing tensor {tname}")));
                    }
                    return Ok(None);
                }
            };
            let count: usize = meta.dims.iter().product();
            let start = data_start + meta.offset;
            let mut out = vec![0.0f32; count];
            match meta.ttype {
                0 => {
                    let byte_len = count * 4;
                    if start + byte_len > bytes.len() {
                        return Err(Error::from_reason(format!("truncated F32 tensor {tname}")));
                    }
                    for i in 0..count {
                        let p = start + i * 4;
                        out[i] = f32::from_le_bytes([
                            bytes[p],
                            bytes[p + 1],
                            bytes[p + 2],
                            bytes[p + 3],
                        ]);
                    }
                }
                1 => {
                    let byte_len = count * 2;
                    if start + byte_len > bytes.len() {
                        return Err(Error::from_reason(format!("truncated F16 tensor {tname}")));
                    }
                    for i in 0..count {
                        let p = start + i * 2;
                        let h = u16::from_le_bytes([bytes[p], bytes[p + 1]]);
                        out[i] = f16_to_f32(h);
                    }
                }
                8 => {
                    let n_blocks = count / 32;
                    let byte_len = n_blocks * 34;
                    if start + byte_len > bytes.len() {
                        return Err(Error::from_reason(format!("truncated Q8_0 tensor {tname}")));
                    }
                    for b in 0..n_blocks {
                        let p = start + b * 34;
                        let d = f16_to_f32(u16::from_le_bytes([bytes[p], bytes[p + 1]]));
                        let base = b * 32;
                        for j in 0..32 {
                            out[base + j] = d * (bytes[p + 2 + j] as i8 as f32);
                        }
                    }
                }
                other => {
                    return Err(Error::from_reason(format!(
                        "unsupported tensor type {other} for {tname}"
                    )))
                }
            }
            Ok(Some(out))
        };

        let req = |tname: &str| -> Result<Vec<f32>> {
            Ok(decode_tensor(tname, true)?.unwrap())
        };

        let tok_embd = req("token_embd.weight")?;
        let pos_embd = decode_tensor("position_embd.weight", false)?;
        let type_embd = decode_tensor("token_types.weight", false)?;
        let embd_norm_w = req("token_embd_norm.weight")?;
        let embd_norm_b = req("token_embd_norm.bias")?;

        let mut blocks = Vec::with_capacity(n_layer);
        for l in 0..n_layer {
            if arch == "nomic-bert" {
                blocks.push(BlockWeights::NomicBert {
                    qkv_w: req(&format!("blk.{l}.attn_qkv.weight"))?,
                    out_w: req(&format!("blk.{l}.attn_output.weight"))?,
                    attn_norm_w: req(&format!("blk.{l}.attn_output_norm.weight"))?,
                    attn_norm_b: req(&format!("blk.{l}.attn_output_norm.bias"))?,
                    up_w: req(&format!("blk.{l}.ffn_up.weight"))?,
                    gate_w: req(&format!("blk.{l}.ffn_gate.weight"))?,
                    down_w: req(&format!("blk.{l}.ffn_down.weight"))?,
                    ffn_norm_w: req(&format!("blk.{l}.layer_output_norm.weight"))?,
                    ffn_norm_b: req(&format!("blk.{l}.layer_output_norm.bias"))?,
                });
            } else {
                blocks.push(BlockWeights::Bert {
                    q_w: req(&format!("blk.{l}.attn_q.weight"))?,
                    q_b: req(&format!("blk.{l}.attn_q.bias"))?,
                    k_w: req(&format!("blk.{l}.attn_k.weight"))?,
                    k_b: req(&format!("blk.{l}.attn_k.bias"))?,
                    v_w: req(&format!("blk.{l}.attn_v.weight"))?,
                    v_b: req(&format!("blk.{l}.attn_v.bias"))?,
                    out_w: req(&format!("blk.{l}.attn_output.weight"))?,
                    out_b: req(&format!("blk.{l}.attn_output.bias"))?,
                    attn_norm_w: req(&format!("blk.{l}.attn_output_norm.weight"))?,
                    attn_norm_b: req(&format!("blk.{l}.attn_output_norm.bias"))?,
                    up_w: req(&format!("blk.{l}.ffn_up.weight"))?,
                    up_b: req(&format!("blk.{l}.ffn_up.bias"))?,
                    down_w: req(&format!("blk.{l}.ffn_down.weight"))?,
                    down_b: req(&format!("blk.{l}.ffn_down.bias"))?,
                    ffn_norm_w: req(&format!("blk.{l}.layer_output_norm.weight"))?,
                    ffn_norm_b: req(&format!("blk.{l}.layer_output_norm.bias"))?,
                });
            }
        }

        Ok(Self {
            name,
            arch,
            d_model,
            d_ffn,
            n_head,
            n_layer,
            eps,
            pool_type,
            rope_base,
            cls_id,
            sep_id,
            unk_id,
            vocab,
            tok_embd,
            pos_embd,
            type_embd,
            embd_norm_w,
            embd_norm_b,
            blocks,
        })
    }

    fn tokenize(&self, text: &str) -> Vec<usize> {
        let lower = text.to_lowercase();
        let mut words = Vec::new();
        let mut cur = String::new();
        for ch in lower.chars() {
            if ch.is_ascii_alphanumeric() {
                cur.push(ch);
            } else {
                if !cur.is_empty() {
                    words.push(std::mem::take(&mut cur));
                }
                if !ch.is_whitespace() && !ch.is_control() {
                    words.push(ch.to_string());
                }
            }
        }
        if !cur.is_empty() {
            words.push(cur);
        }
        let mut ids = Vec::with_capacity(words.len() + 2);
        ids.push(self.cls_id);
        for w in words {
            let chars: Vec<char> = w.chars().collect();
            let mut start = 0usize;
            let mut sub = Vec::new();
            while start < chars.len() {
                let mut end = chars.len();
                let mut found = None;
                while start < end {
                    let slice: String = chars[start..end].iter().collect();
                    let piece = if start == 0 {
                        format!("\u{2581}{slice}")
                    } else {
                        slice
                    };
                    if let Some(&id) = self.vocab.get(&piece) {
                        found = Some(id);
                        break;
                    }
                    end -= 1;
                }
                if let Some(id) = found {
                    sub.push(id);
                    start = end;
                } else {
                    sub.clear();
                    sub.push(self.unk_id);
                    break;
                }
            }
            for id in sub {
                if ids.len() < 511 {
                    ids.push(id);
                }
            }
        }
        ids.push(self.sep_id);
        ids
    }

    fn layer_norm(&self, x: &mut [f32], t_len: usize, w: &[f32], b: &[f32]) {
        let d = self.d_model;
        for t in 0..t_len {
            let row = &mut x[t * d..(t + 1) * d];
            let mut mean = 0.0f32;
            for &v in row.iter() {
                mean += v;
            }
            mean /= d as f32;
            let mut var = 0.0f32;
            for &v in row.iter() {
                let diff = v - mean;
                var += diff * diff;
            }
            let inv = 1.0f32 / (var / (d as f32) + self.eps).sqrt();
            for i in 0..d {
                row[i] = (row[i] - mean) * inv * w[i] + b[i];
            }
        }
    }

    fn linear(t_len: usize, in_d: usize, out_d: usize, x: &[f32], w: &[f32], b: Option<&[f32]>) -> Vec<f32> {
        let mut y = vec![0.0f32; t_len * out_d];
        sgemm_nt(t_len, out_d, in_d, x, w, &mut y);
        if let Some(bias) = b {
            for t in 0..t_len {
                let row = &mut y[t * out_d..(t + 1) * out_d];
                for i in 0..out_d {
                    row[i] += bias[i];
                }
            }
        }
        y
    }

    fn forward(&self, text: &str, is_query: bool) -> Vec<f64> {
        let formatted = if self.arch == "nomic-bert" {
            if is_query {
                format!("search_query: {text}")
            } else {
                format!("search_document: {text}")
            }
        } else if is_query && self.name.starts_with("bge-") {
            format!("Represent this sentence for searching relevant passages: {text}")
        } else {
            text.to_string()
        };
        let ids = self.tokenize(&formatted);
        let t_len = ids.len();
        let d = self.d_model;
        let mut x = vec![0.0f32; t_len * d];
        for (t, &id) in ids.iter().enumerate() {
            let dst = &mut x[t * d..(t + 1) * d];
            let tok_src = &self.tok_embd[id * d..(id + 1) * d];
            for i in 0..d {
                let mut v = tok_src[i];
                if let Some(ref pos) = self.pos_embd {
                    if (t + 1) * d <= pos.len() {
                        v += pos[t * d + i];
                    }
                }
                if let Some(ref tt) = self.type_embd {
                    v += tt[i];
                }
                dst[i] = v;
            }
        }
        self.layer_norm(&mut x, t_len, &self.embd_norm_w, &self.embd_norm_b);

        let head_dim = d / self.n_head;
        let scale = 1.0f32 / (head_dim as f32).sqrt();

        for block in &self.blocks {
            match block {
                BlockWeights::Bert {
                    q_w,
                    q_b,
                    k_w,
                    k_b,
                    v_w,
                    v_b,
                    out_w,
                    out_b,
                    attn_norm_w,
                    attn_norm_b,
                    up_w,
                    up_b,
                    down_w,
                    down_b,
                    ffn_norm_w,
                    ffn_norm_b,
                } => {
                    let q = Self::linear(t_len, d, d, &x, q_w, Some(q_b));
                    let k = Self::linear(t_len, d, d, &x, k_w, Some(k_b));
                    let v = Self::linear(t_len, d, d, &x, v_w, Some(v_b));
                    let attn_out = self.multi_head_attn(t_len, head_dim, scale, &q, &k, &v);
                    let proj = Self::linear(t_len, d, d, &attn_out, out_w, Some(out_b));
                    for i in 0..x.len() {
                        x[i] += proj[i];
                    }
                    self.layer_norm(&mut x, t_len, attn_norm_w, attn_norm_b);

                    let mut up = Self::linear(t_len, d, self.d_ffn, &x, up_w, Some(up_b));
                    for v_ref in up.iter_mut() {
                        let val = *v_ref;
                        *v_ref = 0.5
                            * val
                            * (1.0
                                + (0.7978845608028654 * (val + 0.044715 * val * val * val)).tanh());
                    }
                    let down = Self::linear(t_len, self.d_ffn, d, &up, down_w, Some(down_b));
                    for i in 0..x.len() {
                        x[i] += down[i];
                    }
                    self.layer_norm(&mut x, t_len, ffn_norm_w, ffn_norm_b);
                }
                BlockWeights::NomicBert {
                    qkv_w,
                    out_w,
                    attn_norm_w,
                    attn_norm_b,
                    up_w,
                    gate_w,
                    down_w,
                    ffn_norm_w,
                    ffn_norm_b,
                } => {
                    let qkv = Self::linear(t_len, d, 3 * d, &x, qkv_w, None);
                    let mut q = vec![0.0f32; t_len * d];
                    let mut k = vec![0.0f32; t_len * d];
                    let mut v = vec![0.0f32; t_len * d];
                    for t in 0..t_len {
                        let src = &qkv[t * 3 * d..(t + 1) * 3 * d];
                        q[t * d..(t + 1) * d].copy_from_slice(&src[0..d]);
                        k[t * d..(t + 1) * d].copy_from_slice(&src[d..2 * d]);
                        v[t * d..(t + 1) * d].copy_from_slice(&src[2 * d..3 * d]);
                    }
                    let half = head_dim / 2;
                    for t in 0..t_len {
                        for h in 0..self.n_head {
                            let off = t * d + h * head_dim;
                            for i in 0..half {
                                let theta = (t as f32)
                                    * self.rope_base.powf(-2.0 * (i as f32) / (head_dim as f32));
                                let (sin, cos) = theta.sin_cos();
                                let q0 = q[off + i];
                                let q1 = q[off + i + half];
                                q[off + i] = q0 * cos - q1 * sin;
                                q[off + i + half] = q0 * sin + q1 * cos;
                                let k0 = k[off + i];
                                let k1 = k[off + i + half];
                                k[off + i] = k0 * cos - k1 * sin;
                                k[off + i + half] = k0 * sin + k1 * cos;
                            }
                        }
                    }
                    let attn_out = self.multi_head_attn(t_len, head_dim, scale, &q, &k, &v);
                    let proj = Self::linear(t_len, d, d, &attn_out, out_w, None);
                    for i in 0..x.len() {
                        x[i] += proj[i];
                    }
                    self.layer_norm(&mut x, t_len, attn_norm_w, attn_norm_b);

                    let mut up = Self::linear(t_len, d, self.d_ffn, &x, up_w, None);
                    let gate = Self::linear(t_len, d, self.d_ffn, &x, gate_w, None);
                    for i in 0..up.len() {
                        let g = gate[i];
                        let silu = g / (1.0 + (-g).exp());
                        up[i] *= silu;
                    }
                    let down = Self::linear(t_len, self.d_ffn, d, &up, down_w, None);
                    for i in 0..x.len() {
                        x[i] += down[i];
                    }
                    self.layer_norm(&mut x, t_len, ffn_norm_w, ffn_norm_b);
                }
            }
        }

        let mut out = vec![0.0f32; d];
        if self.pool_type == 2 {
            out.copy_from_slice(&x[0..d]);
        } else {
            for t in 0..t_len {
                let row = &x[t * d..(t + 1) * d];
                for i in 0..d {
                    out[i] += row[i];
                }
            }
            let inv_t = 1.0f32 / (t_len as f32);
            for i in 0..d {
                out[i] *= inv_t;
            }
        }
        let mut norm = 0.0f32;
        for &val in &out {
            norm += val * val;
        }
        norm = norm.sqrt();
        if norm > 0.0 {
            for val in out.iter_mut() {
                *val /= norm;
            }
        }
        out.into_iter().map(|v| v as f64).collect()
    }

    fn multi_head_attn(
        &self,
        t_len: usize,
        head_dim: usize,
        scale: f32,
        q: &[f32],
        k: &[f32],
        v: &[f32],
    ) -> Vec<f32> {
        let d = self.d_model;
        let mut attn_out = vec![0.0f32; t_len * d];
        let mut scores = vec![0.0f32; t_len];
        for h in 0..self.n_head {
            let h_off = h * head_dim;
            for t1 in 0..t_len {
                let q_slice = &q[t1 * d + h_off..t1 * d + h_off + head_dim];
                let mut max_s = f32::NEG_INFINITY;
                for t2 in 0..t_len {
                    let k_slice = &k[t2 * d + h_off..t2 * d + h_off + head_dim];
                    let mut s = 0.0f32;
                    for i in 0..head_dim {
                        s += q_slice[i] * k_slice[i];
                    }
                    s *= scale;
                    scores[t2] = s;
                    if s > max_s {
                        max_s = s;
                    }
                }
                let mut sum_exp = 0.0f32;
                for s in scores.iter_mut() {
                    *s = (*s - max_s).exp();
                    sum_exp += *s;
                }
                let inv_sum = 1.0f32 / sum_exp;
                let out_slice = &mut attn_out[t1 * d + h_off..t1 * d + h_off + head_dim];
                for t2 in 0..t_len {
                    let w = scores[t2] * inv_sum;
                    let v_slice = &v[t2 * d + h_off..t2 * d + h_off + head_dim];
                    for i in 0..head_dim {
                        out_slice[i] += w * v_slice[i];
                    }
                }
            }
        }
        attn_out
    }
}

static MODELS: OnceLock<Mutex<HashMap<u32, Arc<EmbedModel>>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

fn models() -> &'static Mutex<HashMap<u32, Arc<EmbedModel>>> {
    MODELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_model(handle: u32) -> Result<Arc<EmbedModel>> {
    let map = match models().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.get(&handle)
        .cloned()
        .ok_or_else(|| Error::from_reason(format!("no loaded embedding model with handle {handle}")))
}

#[napi(object)]
pub struct CpuFloorAnswer {
    pub arch: String,
    pub floor: String,
    pub met: bool,
    pub missing: Vec<String>,
}

#[napi(object)]
pub struct EmbedModelInfo {
    pub name: String,
    pub architecture: String,
    pub dimension: u32,
    pub layers: u32,
    pub pooling: String,
}

#[napi]
pub fn pack_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn engine_version() -> String {
    "1.0.0".to_string()
}

#[napi]
pub fn system_info() -> String {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "CPU : NEON = 1 | ACCELERATE = 1".to_string();
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "CPU : AVX2 = 1 | FMA = 1 | ACCELERATE = 1".to_string();
    }
    #[cfg(all(not(target_os = "macos"), target_arch = "x86_64"))]
    {
        return "CPU : AVX2 = 1 | FMA = 1 | F16C = 1".to_string();
    }
    #[cfg(all(not(target_os = "macos"), target_arch = "aarch64"))]
    {
        return "CPU : NEON = 1".to_string();
    }
    #[allow(unreachable_code)]
    "CPU : scalar = 1".to_string()
}

#[napi]
pub fn cpu_floor() -> CpuFloorAnswer {
    #[cfg(target_arch = "x86_64")]
    {
        let mut missing = Vec::new();
        if !std::is_x86_feature_detected!("avx2") {
            missing.push("avx2".to_string());
        }
        if !std::is_x86_feature_detected!("fma") {
            missing.push("fma".to_string());
        }
        if !std::is_x86_feature_detected!("f16c") {
            missing.push("f16c".to_string());
        }
        return CpuFloorAnswer {
            arch: "x86_64".to_string(),
            floor: "x86-64 with AVX2, FMA and F16C".to_string(),
            met: missing.is_empty(),
            missing,
        };
    }
    #[cfg(target_arch = "aarch64")]
    {
        return CpuFloorAnswer {
            arch: "aarch64".to_string(),
            floor: "arm64 (NEON)".to_string(),
            met: true,
            missing: Vec::new(),
        };
    }
    #[allow(unreachable_code)]
    CpuFloorAnswer {
        arch: std::env::consts::ARCH.to_string(),
        floor: format!("{} baseline", std::env::consts::ARCH),
        met: true,
        missing: Vec::new(),
    }
}

#[napi]
pub fn load_model(path: String) -> Result<u32> {
    let model = Arc::new(EmbedModel::from_gguf(&path)?);
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    let mut map = match models().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.insert(handle, model);
    Ok(handle)
}

#[napi]
pub fn model_info(handle: u32) -> Result<EmbedModelInfo> {
    let m = get_model(handle)?;
    Ok(EmbedModelInfo {
        name: m.name.clone(),
        architecture: m.arch.clone(),
        dimension: m.d_model as u32,
        layers: m.n_layer as u32,
        pooling: if m.pool_type == 2 {
            "cls".to_string()
        } else {
            "mean".to_string()
        },
    })
}

#[napi]
pub fn embed(handle: u32, text: String, is_query: Option<bool>) -> Result<Vec<f64>> {
    let m = get_model(handle)?;
    Ok(m.forward(&text, is_query.unwrap_or(false)))
}

#[napi]
pub fn embed_batch(
    handle: u32,
    texts: Vec<String>,
    is_query: Option<bool>,
) -> Result<Vec<Vec<f64>>> {
    let m = get_model(handle)?;
    let q = is_query.unwrap_or(false);
    Ok(texts.iter().map(|t| m.forward(t, q)).collect())
}

pub struct EmbedJob {
    model: Arc<EmbedModel>,
    texts: Vec<String>,
    is_query: bool,
}

impl Task for EmbedJob {
    type Output = Vec<Vec<f64>>;
    type JsValue = Vec<Vec<f64>>;

    fn compute(&mut self) -> Result<Vec<Vec<f64>>> {
        Ok(self
            .texts
            .iter()
            .map(|t| self.model.forward(t, self.is_query))
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Vec<Vec<f64>>) -> Result<Vec<Vec<f64>>> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<number[][]>")]
pub fn embed_batch_async(
    handle: u32,
    texts: Vec<String>,
    is_query: Option<bool>,
) -> Result<AsyncTask<EmbedJob>> {
    let model = get_model(handle)?;
    Ok(AsyncTask::new(EmbedJob {
        model,
        texts,
        is_query: is_query.unwrap_or(false),
    }))
}

#[napi]
pub fn unload_model(handle: u32) -> Result<()> {
    let mut map = match models().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    map.remove(&handle);
    Ok(())
}
