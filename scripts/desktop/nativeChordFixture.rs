#![allow(dead_code)]
use std::ffi::c_void;
use std::sync::{Mutex, MutexGuard, OnceLock};
mod keys;
use keys::{KeyName, Modifier};

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
    fn CGEventCreateKeyboardEvent(source: CGEventSourceRef, keycode: u16, down: bool) -> CGEventRef;
    fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
    fn CGEventKeyboardGetUnicodeString(event: CGEventRef, max_length: usize, actual_length: *mut usize, string: *mut u16);
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetType(event: CGEventRef) -> u32;
}

const FIELD_KEYBOARD_KEYCODE: u32 = 9;
const EVENT_KEY_DOWN: u32 = 10;
const EVENT_KEY_UP: u32 = 11;

#[derive(Clone, Debug, PartialEq)]
struct Built {
    kind: u32,
    keycode: u16,
    flags: u64,
    text: String,
}

static BUILT: OnceLock<Mutex<Vec<Built>>> = OnceLock::new();
fn built() -> MutexGuard<'static, Vec<Built>> { BUILT.get_or_init(|| Mutex::new(Vec::new())).lock().unwrap() }
fn reset() { built().clear(); }
fn last() -> Built { built().last().cloned().expect("a key event was built") }

unsafe fn post(event: CGEventRef) -> Result<(), String> {
    if event.is_null() {
        return Err("the event could not be created".to_string());
    }
    let mut units = [0u16; 4];
    let mut length = 0usize;
    CGEventKeyboardGetUnicodeString(event, units.len(), &mut length, units.as_mut_ptr());
    built().push(Built {
        kind: CGEventGetType(event),
        keycode: CGEventGetIntegerValueField(event, FIELD_KEYBOARD_KEYCODE) as u16,
        flags: CGEventGetFlags(event),
        text: String::from_utf16_lossy(&units[..length.min(units.len())]),
    });
    CFRelease(event);
    Ok(())
}

const CHORD_FLAGS: u64 = FLAG_CONTROL | FLAG_ALTERNATE | FLAG_COMMAND;
fn chorded(flags: u64) -> bool { flags & CHORD_FLAGS != 0 }

#[test]
fn a_command_chord_character_key_carries_the_flag_and_no_unicode_string() {
    reset();
    key(KeyName::Char(b'q'), true, false, &[Modifier::Super]).unwrap();
    let event = last();
    assert_eq!(event.kind, EVENT_KEY_DOWN);
    assert_eq!(event.keycode, 0x0c);
    assert!(event.flags & FLAG_COMMAND != 0, "the Command flag rides the key: {:#x}", event.flags);
    assert_eq!(event.text, "", "a chorded key carries no Unicode string, so the application matches its own shortcut from the keycode");
    key(KeyName::Char(b'q'), false, false, &[Modifier::Super]).unwrap();
    let release = last();
    assert_eq!(release.kind, EVENT_KEY_UP);
    assert!(release.flags & FLAG_COMMAND != 0);
    assert_eq!(release.text, "");
}

#[test]
fn control_and_option_chords_carry_no_unicode_string_either() {
    reset();
    key(KeyName::Char(b'c'), true, false, &[Modifier::Control]).unwrap();
    assert!(last().flags & FLAG_CONTROL != 0);
    assert_eq!(last().text, "");
    key(KeyName::Char(b'e'), true, false, &[Modifier::Alt]).unwrap();
    assert!(last().flags & FLAG_ALTERNATE != 0);
    assert_eq!(last().text, "");
    key(KeyName::Char(b's'), true, true, &[Modifier::Super, Modifier::Shift]).unwrap();
    let both = last();
    assert!(both.flags & FLAG_COMMAND != 0 && both.flags & FLAG_SHIFT != 0);
    assert_eq!(both.text, "");
}

#[test]
fn a_plain_character_key_keeps_its_unicode_string() {
    reset();
    key(KeyName::Char(b'2'), true, false, &[]).unwrap();
    let event = last();
    assert_eq!(event.keycode, 0x13);
    assert!(!chorded(event.flags));
    assert_eq!(event.text, "2");
    key(KeyName::Space, true, false, &[]).unwrap();
    assert_eq!(last().text, " ");
}

#[test]
fn a_shifted_character_key_keeps_its_unicode_string_with_the_shift_flag() {
    reset();
    key(KeyName::Char(b'a'), true, true, &[Modifier::Shift]).unwrap();
    let event = last();
    assert!(event.flags & FLAG_SHIFT != 0);
    assert!(!chorded(event.flags));
    assert_eq!(event.text, "A");
    key(KeyName::Char(b'1'), true, false, &[Modifier::Shift]).unwrap();
    assert_eq!(last().text, "1");
}

#[test]
fn named_keys_never_carry_a_unicode_string() {
    reset();
    key(KeyName::Tab, true, false, &[Modifier::Super]).unwrap();
    let tab = last();
    assert_eq!(tab.keycode, KEY_TAB);
    assert!(tab.flags & FLAG_COMMAND != 0);
    assert_eq!(tab.text, "");
    key(KeyName::Enter, true, false, &[]).unwrap();
    assert_eq!(last().text, "");
    key(KeyName::Super, true, false, &[Modifier::Super]).unwrap();
    assert_eq!(last().keycode, KEY_COMMAND);
    assert_eq!(last().text, "");
}

#[test]
fn a_shifted_symbol_rides_the_shift_flag_without_a_chord() {
    reset();
    key(KeyName::Char(b'!'), true, false, &[]).unwrap();
    let bang = last();
    assert_eq!(bang.keycode, 0x12);
    assert!(bang.flags & FLAG_SHIFT != 0);
    assert_eq!(bang.text, "!");
}
