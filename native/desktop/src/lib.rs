use std::cmp::Ordering as CmpOrdering;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use napi::Task;
use napi_derive::napi;

mod keys;
mod png;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as imp;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as imp;

#[cfg(target_os = "linux")]
mod x11;
#[cfg(target_os = "linux")]
use x11 as imp;

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod none;
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
use none as imp;

use keys::{Button, KeyName, Modifier};

pub const DRAG_STEPS: u32 = 16;
pub const DRAG_STEP_MS: u64 = 8;
pub const TYPE_GAP_DEFAULT_MS: u32 = 4;
pub const TYPE_GAP_CAP_MS: u32 = 1000;
pub const ABORTED: &str = "aborted";

#[napi(object)]
#[derive(Clone)]
pub struct PermissionsAnswer {
    pub session: String,
    pub screen_capture: String,
    pub input: String,
    pub reason: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct DisplayRecord {
    pub index: u32,
    pub id: String,
    pub origin_x: f64,
    pub origin_y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub primary: bool,
}

#[napi(object)]
pub struct DisplaysAnswer {
    pub displays: Vec<DisplayRecord>,
    pub reason: Option<String>,
}

#[napi(object)]
pub struct CaptureAnswer {
    pub png: Buffer,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub display: u32,
    pub display_id: String,
    pub origin_x: f64,
    pub origin_y: f64,
    pub captured_at: f64,
}

#[napi(object)]
#[derive(Clone)]
pub struct BoundsRecord {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[napi(object)]
pub struct ApplicationAnswer {
    pub identity: Option<String>,
    pub name: Option<String>,
    pub pid: Option<u32>,
    pub title: Option<String>,
    pub bounds: Option<BoundsRecord>,
    pub reason: Option<String>,
}

impl ApplicationAnswer {
    pub fn refused(reason: &str) -> ApplicationAnswer {
        ApplicationAnswer { identity: None, name: None, pid: None, title: None, bounds: None, reason: Some(reason.to_string()) }
    }

    pub fn found(identity: String, name: Option<String>, pid: Option<u32>, title: Option<String>, bounds: Option<BoundsRecord>) -> ApplicationAnswer {
        ApplicationAnswer { identity: Some(identity), name, pid, title, bounds, reason: None }
    }
}

#[napi(object)]
pub struct CursorAnswer {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub display: Option<u32>,
    pub reason: Option<String>,
}

#[napi(object)]
pub struct HeldAnswer {
    pub buttons: Vec<String>,
    pub keys: Vec<String>,
}

#[derive(Default)]
struct Held {
    buttons: Vec<Button>,
    keys: Vec<KeyName>,
}

static HELD: OnceLock<Mutex<Held>> = OnceLock::new();
static CANCEL: AtomicBool = AtomicBool::new(false);

fn held_state() -> MutexGuard<'static, Held> {
    match HELD.get_or_init(|| Mutex::new(Held::default())).lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn held_modifiers() -> Vec<Modifier> {
    held_state().keys.iter().filter_map(|key| key.modifier()).collect()
}

fn reason(text: String) -> Error {
    Error::from_reason(text)
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn grant_ok(grant: &str) -> bool {
    grant == "granted" || grant == "not-required"
}

fn desktop_session(permissions: &PermissionsAnswer) -> std::result::Result<(), String> {
    if permissions.session == "desktop" {
        return Ok(());
    }
    Err(permissions
        .reason
        .clone()
        .unwrap_or_else(|| format!("no desktop session to drive (the session is {})", permissions.session)))
}

fn grant_refusal(what: &str, grant: &str, permissions: &PermissionsAnswer) -> String {
    match &permissions.reason {
        Some(text) => format!("{what} is not granted ({grant}) — {text}"),
        None => format!("{what} is not granted ({grant})"),
    }
}

fn screen_preflight() -> std::result::Result<(), String> {
    let permissions = imp::permissions(false);
    desktop_session(&permissions)?;
    if !grant_ok(&permissions.screen_capture) {
        return Err(grant_refusal("screen capture", &permissions.screen_capture, &permissions));
    }
    Ok(())
}

fn input_preflight() -> std::result::Result<(), String> {
    let permissions = imp::permissions(false);
    desktop_session(&permissions)?;
    if !grant_ok(&permissions.input) {
        return Err(grant_refusal("input control", &permissions.input, &permissions));
    }
    Ok(())
}

fn begin_act() -> Result<()> {
    CANCEL.store(false, Ordering::SeqCst);
    input_preflight().map_err(reason)
}

fn ordered(mut list: Vec<DisplayRecord>) -> Vec<DisplayRecord> {
    list.sort_by(|a, b| {
        b.primary
            .cmp(&a.primary)
            .then(a.origin_y.partial_cmp(&b.origin_y).unwrap_or(CmpOrdering::Equal))
            .then(a.origin_x.partial_cmp(&b.origin_x).unwrap_or(CmpOrdering::Equal))
    });
    for (index, display) in list.iter_mut().enumerate() {
        display.index = index as u32;
    }
    list
}

fn display_list() -> std::result::Result<Vec<DisplayRecord>, String> {
    imp::displays().map(ordered)
}

fn display_at(x: f64, y: f64) -> Option<u32> {
    display_list()
        .ok()?
        .into_iter()
        .find(|d| x >= d.origin_x && x < d.origin_x + d.width && y >= d.origin_y && y < d.origin_y + d.height)
        .map(|d| d.index)
}

#[napi]
pub fn pack_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn permissions() -> PermissionsAnswer {
    imp::permissions(false)
}

#[napi]
pub fn request_permissions() -> PermissionsAnswer {
    imp::permissions(true)
}

#[napi]
pub fn displays() -> DisplaysAnswer {
    match display_list() {
        Ok(displays) => DisplaysAnswer { displays, reason: None },
        Err(text) => DisplaysAnswer { displays: Vec::new(), reason: Some(text) },
    }
}

pub struct CaptureTask {
    display: DisplayRecord,
}

pub struct CaptureOutput {
    png: Vec<u8>,
    width: u32,
    height: u32,
    captured_at: f64,
}

impl Task for CaptureTask {
    type Output = CaptureOutput;
    type JsValue = CaptureAnswer;

    fn compute(&mut self) -> Result<CaptureOutput> {
        let (width, height, rgba) = imp::capture(&self.display).map_err(reason)?;
        let png = png::encode_rgba(width, height, &rgba).map_err(reason)?;
        Ok(CaptureOutput { png, width, height, captured_at: now_ms() })
    }

    fn resolve(&mut self, _env: Env, output: CaptureOutput) -> Result<CaptureAnswer> {
        let scale = if self.display.width > 0.0 { output.width as f64 / self.display.width } else { self.display.scale };
        Ok(CaptureAnswer {
            png: Buffer::from(output.png),
            width: output.width,
            height: output.height,
            scale,
            display: self.display.index,
            display_id: self.display.id.clone(),
            origin_x: self.display.origin_x,
            origin_y: self.display.origin_y,
            captured_at: output.captured_at,
        })
    }
}

#[napi(ts_return_type = "Promise<CaptureAnswer>")]
pub fn capture(display: u32) -> Result<AsyncTask<CaptureTask>> {
    CANCEL.store(false, Ordering::SeqCst);
    screen_preflight().map_err(reason)?;
    let list = display_list().map_err(reason)?;
    let record = list
        .into_iter()
        .find(|d| d.index == display)
        .ok_or_else(|| reason(format!("no display {display}")))?;
    Ok(AsyncTask::new(CaptureTask { display: record }))
}

#[napi]
pub fn frontmost_application() -> ApplicationAnswer {
    imp::frontmost_application()
}

#[napi]
pub fn own_terminal_application() -> ApplicationAnswer {
    imp::own_terminal_application()
}

#[napi]
pub fn cursor() -> CursorAnswer {
    match imp::cursor() {
        Ok((x, y)) => CursorAnswer { x: Some(x), y: Some(y), display: display_at(x, y), reason: None },
        Err(text) => CursorAnswer { x: None, y: None, display: None, reason: Some(text) },
    }
}

#[napi]
pub fn mouse_move(x: f64, y: f64) -> Result<()> {
    begin_act()?;
    imp::mouse_move(x, y).map_err(reason)
}

#[napi]
pub fn mouse_down(button: String) -> Result<()> {
    begin_act()?;
    let button = Button::parse(&button).map_err(reason)?;
    let (x, y) = imp::cursor().map_err(reason)?;
    {
        let mut held = held_state();
        if !held.buttons.contains(&button) {
            held.buttons.push(button);
        }
    }
    imp::mouse_button(button, true, x, y, 1).map_err(reason)
}

#[napi]
pub fn mouse_up(button: String) -> Result<()> {
    begin_act()?;
    let button = Button::parse(&button).map_err(reason)?;
    let (x, y) = imp::cursor().map_err(reason)?;
    imp::mouse_button(button, false, x, y, 1).map_err(reason)?;
    held_state().buttons.retain(|held| *held != button);
    Ok(())
}

#[napi]
pub fn click(x: f64, y: f64, button: String, count: u32) -> Result<()> {
    begin_act()?;
    let button = Button::parse(&button).map_err(reason)?;
    if !(1..=3).contains(&count) {
        return Err(reason(format!("a click count is 1, 2 or 3 (got {count})")));
    }
    imp::mouse_move(x, y).map_err(reason)?;
    for n in 1..=count {
        if let Err(text) = imp::mouse_button(button, true, x, y, n) {
            let _ = imp::mouse_button(button, false, x, y, n);
            return Err(reason(text));
        }
        imp::mouse_button(button, false, x, y, n).map_err(reason)?;
    }
    Ok(())
}

pub struct DragTask {
    from: (f64, f64),
    to: (f64, f64),
    button: Button,
}

impl Task for DragTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        let (from_x, from_y) = self.from;
        let (to_x, to_y) = self.to;
        let button = self.button;
        imp::mouse_move(from_x, from_y).map_err(reason)?;
        {
            let mut held = held_state();
            if !held.buttons.contains(&button) {
                held.buttons.push(button);
            }
        }
        let stepped = (|| -> std::result::Result<(f64, f64), String> {
            imp::mouse_button(button, true, from_x, from_y, 1)?;
            let mut last = (from_x, from_y);
            for step in 1..=DRAG_STEPS {
                if CANCEL.load(Ordering::SeqCst) {
                    return Err(ABORTED.to_string());
                }
                let t = step as f64 / DRAG_STEPS as f64;
                last = (from_x + (to_x - from_x) * t, from_y + (to_y - from_y) * t);
                imp::mouse_drag(button, last.0, last.1)?;
                sleep(Duration::from_millis(DRAG_STEP_MS));
            }
            Ok(last)
        })();
        let at = match &stepped {
            Ok(point) => *point,
            Err(_) => imp::cursor().unwrap_or((from_x, from_y)),
        };
        let up = imp::mouse_button(button, false, at.0, at.1, 1);
        held_state().buttons.retain(|held| *held != button);
        stepped.map(|_| ()).map_err(reason)?;
        up.map_err(reason)
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

#[napi(ts_return_type = "Promise<void>")]
pub fn drag(from_x: f64, from_y: f64, to_x: f64, to_y: f64, button: String) -> Result<AsyncTask<DragTask>> {
    begin_act()?;
    let button = Button::parse(&button).map_err(reason)?;
    Ok(AsyncTask::new(DragTask { from: (from_x, from_y), to: (to_x, to_y), button }))
}

#[napi]
pub fn scroll(x: f64, y: f64, delta_x: i32, delta_y: i32) -> Result<()> {
    begin_act()?;
    imp::mouse_move(x, y).map_err(reason)?;
    imp::scroll(delta_x, delta_y).map_err(reason)
}

fn chord_of(modifiers: &[String], shifted: bool) -> std::result::Result<Vec<Modifier>, String> {
    let mut chord: Vec<Modifier> = Vec::new();
    for name in modifiers {
        let modifier = Modifier::parse(name)?;
        if !chord.contains(&modifier) {
            chord.push(modifier);
        }
    }
    if shifted && !chord.contains(&Modifier::Shift) {
        chord.push(Modifier::Shift);
    }
    Ok(chord)
}

fn active_with(chord: &[Modifier]) -> Vec<Modifier> {
    let mut active = held_modifiers();
    for modifier in chord {
        if !active.contains(modifier) {
            active.push(*modifier);
        }
    }
    active
}

fn active_without(modifier: Option<Modifier>) -> Vec<Modifier> {
    held_modifiers().into_iter().filter(|held| Some(*held) != modifier).collect()
}

#[napi]
pub fn key_tap(key: String, modifiers: Vec<String>) -> Result<()> {
    begin_act()?;
    let parsed = KeyName::parse(&key).map_err(reason)?;
    let chord = chord_of(&modifiers, parsed.shifted).map_err(reason)?;
    let active = active_with(&chord);
    let mut pressed: Vec<Modifier> = Vec::new();
    let mut outcome: std::result::Result<(), String> = Ok(());
    for modifier in &chord {
        match imp::key(modifier.key(), true, false, &active) {
            Ok(()) => pressed.push(*modifier),
            Err(text) => {
                outcome = Err(text);
                break;
            }
        }
    }
    if outcome.is_ok() {
        outcome = imp::key(parsed.key, true, parsed.shifted, &active).and_then(|_| imp::key(parsed.key, false, parsed.shifted, &active));
    }
    for modifier in pressed.iter().rev() {
        let remaining: Vec<Modifier> = active.iter().copied().filter(|m| m != modifier).collect();
        let released = imp::key(modifier.key(), false, false, &remaining);
        if outcome.is_ok() {
            outcome = released;
        }
    }
    outcome.map_err(reason)
}

#[napi]
pub fn key_down(key: String) -> Result<()> {
    begin_act()?;
    let parsed = KeyName::parse(&key).map_err(reason)?;
    {
        let mut held = held_state();
        if !held.keys.contains(&parsed.key) {
            held.keys.push(parsed.key);
        }
    }
    let active = active_with(&[]);
    imp::key(parsed.key, true, parsed.shifted, &active).map_err(reason)
}

#[napi]
pub fn key_up(key: String) -> Result<()> {
    begin_act()?;
    let parsed = KeyName::parse(&key).map_err(reason)?;
    let active = active_without(parsed.key.modifier());
    imp::key(parsed.key, false, parsed.shifted, &active).map_err(reason)?;
    held_state().keys.retain(|held| *held != parsed.key);
    Ok(())
}

pub struct TypeTask {
    text: String,
    gap_ms: u64,
}

impl Task for TypeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        let chars: Vec<char> = self.text.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if CANCEL.load(Ordering::SeqCst) {
                return Err(reason(ABORTED.to_string()));
            }
            imp::type_char(*c).map_err(reason)?;
            if self.gap_ms > 0 && i + 1 < chars.len() {
                sleep(Duration::from_millis(self.gap_ms));
            }
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

#[napi(ts_return_type = "Promise<void>")]
pub fn type_text(text: String, gap_ms: Option<u32>) -> Result<AsyncTask<TypeTask>> {
    begin_act()?;
    let gap = gap_ms.unwrap_or(TYPE_GAP_DEFAULT_MS).min(TYPE_GAP_CAP_MS) as u64;
    Ok(AsyncTask::new(TypeTask { text, gap_ms: gap }))
}

fn held_answer(held: &Held) -> HeldAnswer {
    HeldAnswer {
        buttons: held.buttons.iter().map(|b| b.name().to_string()).collect(),
        keys: held.keys.iter().map(|k| k.name()).collect(),
    }
}

#[napi]
pub fn held() -> HeldAnswer {
    held_answer(&held_state())
}

#[napi]
pub fn release_all() -> HeldAnswer {
    let (keys, buttons) = {
        let held = held_state();
        (held.keys.clone(), held.buttons.clone())
    };
    let mut released = HeldAnswer { buttons: Vec::new(), keys: Vec::new() };
    let plain: Vec<KeyName> = keys.iter().rev().copied().filter(|k| k.modifier().is_none()).collect();
    let modifiers: Vec<KeyName> = keys.iter().rev().copied().filter(|k| k.modifier().is_some()).collect();
    for key in plain.into_iter().chain(modifiers) {
        let active = active_without(key.modifier());
        if imp::key(key, false, false, &active).is_ok() {
            held_state().keys.retain(|held| *held != key);
            released.keys.push(key.name());
        }
    }
    let (x, y) = imp::cursor().unwrap_or((0.0, 0.0));
    for button in buttons {
        if imp::mouse_button(button, false, x, y, 1).is_ok() {
            held_state().buttons.retain(|held| *held != button);
            released.buttons.push(button.name().to_string());
        }
    }
    released
}

#[napi]
pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}
