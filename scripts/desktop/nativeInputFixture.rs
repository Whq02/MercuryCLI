#![allow(dead_code)]
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};
mod keys;
use keys::{Button, KeyName, Modifier};
type Result<T> = std::result::Result<T, String>;
type Env = ();
trait Task { type Output; type JsValue; fn compute(&mut self) -> Result<Self::Output>; fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue>; }
fn reason(text: String) -> String { text }
fn begin_act() -> Result<()> { Ok(()) }
#[derive(Clone)]
struct DisplayRecord { index: u32, origin_x: f64, origin_y: f64, width: f64, height: f64 }
static DISPLAYS: Mutex<Vec<DisplayRecord>> = Mutex::new(Vec::new());
fn display_list() -> std::result::Result<Vec<DisplayRecord>, String> {
    let listed = DISPLAYS.lock().unwrap().clone();
    if listed.is_empty() { return Ok(vec![DisplayRecord { index: 0, origin_x: 0.0, origin_y: 0.0, width: 1920.0, height: 1080.0 }]); }
    Ok(listed)
}
fn set_displays(displays: Vec<DisplayRecord>) { *DISPLAYS.lock().unwrap() = displays; }
mod imp {
    use super::*;
    static EVENTS: OnceLock<Mutex<Vec<(String, Instant)>>> = OnceLock::new();
    static FAIL_UP: AtomicBool = AtomicBool::new(false);
    static FAIL_DOWN: AtomicBool = AtomicBool::new(false);
    static CANCEL_ON_MOVE: AtomicBool = AtomicBool::new(false);
    fn events() -> MutexGuard<'static, Vec<(String, Instant)>> { EVENTS.get_or_init(|| Mutex::new(Vec::new())).lock().unwrap() }
    fn record(event: String) { events().push((event, Instant::now())); }
    pub fn reset() { events().clear(); FAIL_UP.store(false, Ordering::SeqCst); FAIL_DOWN.store(false, Ordering::SeqCst); CANCEL_ON_MOVE.store(false, Ordering::SeqCst); }
    pub fn fail_up() { FAIL_UP.store(true, Ordering::SeqCst); }
    pub fn fail_down() { FAIL_DOWN.store(true, Ordering::SeqCst); }
    pub fn cancel_on_move() { CANCEL_ON_MOVE.store(true, Ordering::SeqCst); }
    pub fn event_list() -> Vec<String> { events().iter().map(|(event, _)| event.clone()).collect() }
    pub fn event_instants() -> Vec<Instant> { events().iter().map(|(_, at)| *at).collect() }
    pub fn mouse_move(_: f64, _: f64) -> Result<()> { record("move".into()); if CANCEL_ON_MOVE.load(Ordering::SeqCst) { CANCEL.store(true, Ordering::SeqCst); } Ok(()) }
    pub fn mouse_drag(_: Button, x: f64, y: f64) -> Result<()> { record(format!("drag:{x}:{y}")); Ok(()) }
    pub fn cursor() -> Result<(f64, f64)> { Ok((20.0, 20.0)) }
    pub fn mouse_button(button: Button, down: bool, _: f64, _: f64, _: u32) -> Result<()> {
        record(format!("mouse:{}:{}", button.name(), down));
        if !down && FAIL_UP.swap(false, Ordering::SeqCst) { return Err("fixture button release failure".into()); }
        if down && FAIL_DOWN.swap(false, Ordering::SeqCst) { return Err("fixture button press failure".into()); }
        Ok(())
    }
    pub fn key(key: KeyName, down: bool, _: bool, active: &[Modifier]) -> Result<()> {
        record(format!("key:{}:{}:{:?}", key.name(), down, active));
        if !down && FAIL_UP.swap(false, Ordering::SeqCst) { return Err("fixture key release failure".into()); }
        if down && FAIL_DOWN.swap(false, Ordering::SeqCst) { return Err("fixture key press failure".into()); }
        Ok(())
    }
}
fn reset() { *held_state() = Held::default(); CANCEL.store(false, Ordering::SeqCst); imp::reset(); }
#[test]
fn click_release_failure_remains_recoverable() {
    reset(); imp::fail_up();
    assert!(click(20.0, 20.0, "left".into(), 1).is_err());
    assert_eq!(release_all().buttons, vec!["left"]);
    assert!(held().buttons.is_empty());
}
#[test]
fn key_release_failure_remains_recoverable() {
    reset(); imp::fail_up();
    assert!(key_tap("a".into(), vec![]).is_err());
    assert_eq!(release_all().keys, vec!["a"]);
    assert!(held().keys.is_empty());
}
#[test]
fn drag_release_failure_remains_recoverable() {
    reset(); imp::fail_up();
    let mut task = DragTask { from: (0.0, 0.0), to: (20.0, 20.0), button: Button::Left };
    assert!(task.compute().is_err());
    assert_eq!(release_all().buttons, vec!["left"]);
}
#[test]
fn chord_preserves_an_already_held_modifier() {
    reset();
    key_down("shift".into()).unwrap();
    key_tap("a".into(), vec!["shift".into()]).unwrap();
    assert!(!imp::event_list().iter().any(|e| e.starts_with("key:shift:false")));
    assert_eq!(held().keys, vec!["shift"]);
    assert_eq!(release_all().keys, vec!["shift"]);
}
#[test]
fn cancelled_queued_drag_posts_no_input() {
    reset(); CANCEL.store(true, Ordering::SeqCst);
    let mut task = DragTask { from: (0.0, 0.0), to: (20.0, 20.0), button: Button::Left };
    assert!(task.compute().is_err());
    assert!(imp::event_list().is_empty());
}
#[test]
fn cancel_after_initial_move_never_presses() {
    reset(); imp::cancel_on_move();
    let mut task = DragTask { from: (0.0, 0.0), to: (20.0, 20.0), button: Button::Left };
    assert!(task.compute().is_err());
    assert_eq!(imp::event_list(), vec!["move"]);
    assert!(held().buttons.is_empty());
}
#[test]
fn failed_primary_down_still_attempts_release() {
    reset(); imp::fail_down();
    assert!(key_tap("a".into(), vec![]).is_err());
    assert!(imp::event_list().iter().any(|e| e.starts_with("key:a:false")));
    assert!(held().keys.is_empty());
}
#[test]
fn failed_modifier_down_still_attempts_release() {
    reset(); imp::fail_down();
    assert!(key_tap("a".into(), vec!["control".into()]).is_err());
    assert!(imp::event_list().iter().any(|e| e.starts_with("key:control:false")));
    assert!(held().keys.is_empty());
}
#[test]
fn a_command_chord_reaches_the_leaf_as_four_events_with_the_modifier_active_on_the_key() {
    reset();
    key_tap("q".into(), vec!["super".into()]).unwrap();
    assert_eq!(imp::event_list(), vec!["key:super:true:[Super]", "key:q:true:[Super]", "key:q:false:[Super]", "key:super:false:[]"]);
    assert!(held().keys.is_empty());
}
#[test]
fn chord_release_flags_drop_modifiers_in_reverse_order() {
    reset();
    key_tap("a".into(), vec!["control".into(), "shift".into()]).unwrap();
    let events = imp::event_list();
    assert!(events.contains(&"key:shift:false:[Control]".into()));
    assert!(events.contains(&"key:control:false:[]".into()));
    assert!(held().keys.is_empty());
}
#[test]
fn successful_clicks_and_drag_leave_nothing_held() {
    reset();
    click(20.0, 20.0, "left".into(), 2).unwrap();
    assert_eq!(imp::event_list().iter().filter(|e| *e == "mouse:left:true").count(), 2);
    let mut task = DragTask { from: (0.0, 0.0), to: (20.0, 20.0), button: Button::Left };
    task.compute().unwrap();
    assert!(held().buttons.is_empty());
}
#[test]
fn a_drag_holds_at_the_press_then_nudges_a_twentieth_of_a_point_toward_the_origin_before_the_steps() {
    reset();
    let mut task = DragTask { from: (10.0, 10.0), to: (30.0, 30.0), button: Button::Left };
    task.compute().unwrap();
    let events = imp::event_list();
    assert_eq!(&events[..3], ["move", "mouse:left:true", "drag:9.95:9.95"]);
    let drags: Vec<&String> = events.iter().filter(|e| e.starts_with("drag:")).collect();
    assert_eq!(drags.len(), DRAG_STEPS as usize + 1);
    assert_eq!(drags[drags.len() - 1], "drag:30:30");
    assert_eq!(events[events.len() - 1], "mouse:left:false");
    let at = imp::event_instants();
    assert!(at[2] - at[1] >= Duration::from_millis(60), "the pointer holds at the press before the nudge: {:?}", at[2] - at[1]);
    assert!(held().buttons.is_empty());
}
#[test]
fn a_drag_from_the_corner_never_nudges_off_the_display() {
    reset();
    let mut task = DragTask { from: (0.0, 0.0), to: (20.0, 20.0), button: Button::Left };
    task.compute().unwrap();
    assert_eq!(imp::event_list()[2], "drag:0:0");
}
#[test]
fn a_drag_on_a_display_left_of_and_above_the_main_one_nudges_within_that_display() {
    reset();
    set_displays(vec![
        DisplayRecord { index: 0, origin_x: 0.0, origin_y: 0.0, width: 1920.0, height: 1080.0 },
        DisplayRecord { index: 1, origin_x: -2560.0, origin_y: -400.0, width: 2560.0, height: 1440.0 },
    ]);
    let mut task = DragTask { from: (-1000.0, 300.0), to: (-900.0, 300.0), button: Button::Left };
    task.compute().unwrap();
    assert_eq!(imp::event_list()[2], "drag:-1000.05:299.95");
    reset();
    let mut corner = DragTask { from: (-2560.0, -400.0), to: (-2540.0, -380.0), button: Button::Left };
    corner.compute().unwrap();
    assert_eq!(imp::event_list()[2], "drag:-2560:-400");
    set_displays(Vec::new());
}
#[test]
fn a_press_that_no_display_holds_nudges_unclamped() {
    reset();
    set_displays(vec![DisplayRecord { index: 0, origin_x: 0.0, origin_y: 0.0, width: 1920.0, height: 1080.0 }]);
    let mut gap = DragTask { from: (-1000.0, 100.0), to: (-900.0, 100.0), button: Button::Left };
    gap.compute().unwrap();
    assert_eq!(imp::event_list()[2], "drag:-1000.05:99.95");
    set_displays(Vec::new());
}
