use std::ffi::{c_char, c_void, CString};
use std::ptr;

use objc2::msg_send;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSString;

use crate::keys::{Button, KeyName, Modifier};
use crate::{ApplicationAnswer, BoundsRecord, DisplayRecord, PermissionsAnswer};

type CFTypeRef = *const c_void;
type CGEventRef = *mut c_void;
type CGEventSourceRef = *mut c_void;
type CGImageRef = *mut c_void;
type CGDataProviderRef = *mut c_void;
type CGDisplayModeRef = *mut c_void;
type CGDirectDisplayID = u32;

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
    fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    fn CFDictionaryCreate(
        allocator: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFTypeRef;
    fn CFNumberGetValue(number: CFTypeRef, number_type: isize, value: *mut c_void) -> u8;
    fn CFStringCreateWithCString(allocator: CFTypeRef, cstr: *const c_char, encoding: u32) -> CFTypeRef;
    fn CFDataGetLength(data: CFTypeRef) -> isize;
    fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
    static kCFTypeDictionaryKeyCallBacks: [usize; 6];
    static kCFTypeDictionaryValueCallBacks: [usize; 6];
    static kCFBooleanTrue: CFTypeRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGGetActiveDisplayList(max: u32, displays: *mut CGDirectDisplayID, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> CGDirectDisplayID;
    fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
    fn CGDisplayPixelsWide(display: CGDirectDisplayID) -> usize;
    fn CGDisplayCopyDisplayMode(display: CGDirectDisplayID) -> CGDisplayModeRef;
    fn CGDisplayModeGetPixelWidth(mode: CGDisplayModeRef) -> usize;
    fn CGDisplayModeRelease(mode: CGDisplayModeRef);
    fn CGDisplayCreateImage(display: CGDirectDisplayID) -> CGImageRef;
    fn CGImageGetWidth(image: CGImageRef) -> usize;
    fn CGImageGetHeight(image: CGImageRef) -> usize;
    fn CGImageGetBytesPerRow(image: CGImageRef) -> usize;
    fn CGImageGetBitsPerPixel(image: CGImageRef) -> usize;
    fn CGImageGetBitmapInfo(image: CGImageRef) -> u32;
    fn CGImageGetDataProvider(image: CGImageRef) -> CGDataProviderRef;
    fn CGDataProviderCopyData(provider: CGDataProviderRef) -> CFTypeRef;
    fn CGImageRelease(image: CGImageRef);
    fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
    fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    fn CGEventCreateMouseEvent(source: CGEventSourceRef, kind: u32, position: CGPoint, button: u32) -> CGEventRef;
    fn CGEventCreateKeyboardEvent(source: CGEventSourceRef, keycode: u16, down: bool) -> CGEventRef;
    fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
    fn CGEventCreateScrollWheelEvent2(source: CGEventSourceRef, units: u32, wheel_count: u32, wheel1: i32, wheel2: i32, wheel3: i32) -> CGEventRef;
    fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFTypeRef;
    fn CGRectMakeWithDictionaryRepresentation(dict: CFTypeRef, rect: *mut CGRect) -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
    static kAXTrustedCheckOptionPrompt: CFTypeRef;
}

const EVENT_SOURCE_HID_SYSTEM_STATE: i32 = 1;
const HID_EVENT_TAP: u32 = 0;
const MOUSE_EVENT_CLICK_STATE: u32 = 1;
const SCROLL_EVENT_UNIT_LINE: u32 = 1;
const EVENT_MOUSE_MOVED: u32 = 5;
const FLAG_NON_COALESCED: u64 = 0x100;
const FLAG_SHIFT: u64 = 1 << 17;
const FLAG_CONTROL: u64 = 1 << 18;
const FLAG_ALTERNATE: u64 = 1 << 19;
const FLAG_COMMAND: u64 = 1 << 20;
const STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const NUMBER_SINT64: isize = 4;
const WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1;
const WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 16;
const NULL_WINDOW_ID: u32 = 0;
const BITMAP_BYTE_ORDER_MASK: u32 = 0x7000;
const BITMAP_BYTE_ORDER_32_LITTLE: u32 = 0x2000;
const BITMAP_ALPHA_MASK: u32 = 0x1f;
const ALPHA_PREMULTIPLIED_LAST: u32 = 1;
const ALPHA_LAST: u32 = 3;
const ALPHA_NONE_SKIP_LAST: u32 = 5;
const ACTIVATION_POLICY_REGULAR: isize = 0;
const KEY_RETURN: u16 = 0x24;
const KEY_TAB: u16 = 0x30;
const KEY_SPACE: u16 = 0x31;
const KEY_BACKSPACE: u16 = 0x33;
const KEY_ESCAPE: u16 = 0x35;
const KEY_COMMAND: u16 = 0x37;
const KEY_SHIFT: u16 = 0x38;
const KEY_OPTION: u16 = 0x3a;
const KEY_CONTROL: u16 = 0x3b;
const KEY_FORWARD_DELETE: u16 = 0x75;
const KEY_HOME: u16 = 0x73;
const KEY_END: u16 = 0x77;
const KEY_PAGE_UP: u16 = 0x74;
const KEY_PAGE_DOWN: u16 = 0x79;
const KEY_LEFT: u16 = 0x7b;
const KEY_RIGHT: u16 = 0x7c;
const KEY_DOWN: u16 = 0x7d;
const KEY_UP: u16 = 0x7e;
const FUNCTION_KEYS: [u16; 12] = [0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f];

fn rect(x: f64, y: f64, width: f64, height: f64) -> CGRect {
    CGRect { origin: CGPoint { x, y }, size: CGSize { width, height } }
}

fn point(x: f64, y: f64) -> CGPoint {
    CGPoint { x, y }
}

unsafe fn cf_string(text: &str) -> CFTypeRef {
    let c = CString::new(text).unwrap_or_default();
    CFStringCreateWithCString(ptr::null(), c.as_ptr(), STRING_ENCODING_UTF8)
}

unsafe fn cf_number_i64(value: CFTypeRef) -> Option<i64> {
    if value.is_null() {
        return None;
    }
    let mut out: i64 = 0;
    if CFNumberGetValue(value, NUMBER_SINT64, &mut out as *mut i64 as *mut c_void) != 0 {
        Some(out)
    } else {
        None
    }
}

unsafe fn prompt_options() -> CFTypeRef {
    let keys: [CFTypeRef; 1] = [kAXTrustedCheckOptionPrompt];
    let values: [CFTypeRef; 1] = [kCFBooleanTrue];
    CFDictionaryCreate(
        ptr::null(),
        keys.as_ptr(),
        values.as_ptr(),
        1,
        ptr::addr_of!(kCFTypeDictionaryKeyCallBacks) as *const c_void,
        ptr::addr_of!(kCFTypeDictionaryValueCallBacks) as *const c_void,
    )
}

pub fn permissions(request: bool) -> PermissionsAnswer {
    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        let has_session = !session.is_null();
        if has_session {
            CFRelease(session);
        }
        let screen = if request { CGRequestScreenCaptureAccess() } else { CGPreflightScreenCaptureAccess() };
        let input = if request {
            let options = prompt_options();
            let trusted = AXIsProcessTrustedWithOptions(options) != 0;
            if !options.is_null() {
                CFRelease(options);
            }
            trusted
        } else {
            AXIsProcessTrustedWithOptions(ptr::null()) != 0
        };
        let mut reasons: Vec<&str> = Vec::new();
        if !has_session {
            reasons.push("no window server session (a login without a desktop, such as ssh)");
        }
        if !screen {
            reasons.push("Screen Recording is not granted to the responsible process (the terminal application that started Mercury; a process under a scheduler daemon or an ssh login has no terminal to be granted through)");
        }
        if !input {
            reasons.push("Accessibility is not granted to the responsible process (the terminal application that started Mercury)");
        }
        PermissionsAnswer {
            session: if has_session { "desktop" } else { "no-display" }.to_string(),
            screen_capture: if screen { "granted" } else { "denied" }.to_string(),
            input: if input { "granted" } else { "denied" }.to_string(),
            reason: if reasons.is_empty() { None } else { Some(reasons.join("; ")) },
        }
    }
}

unsafe fn display_pixels_wide(id: CGDirectDisplayID) -> usize {
    let mode = CGDisplayCopyDisplayMode(id);
    if mode.is_null() {
        return CGDisplayPixelsWide(id);
    }
    let wide = CGDisplayModeGetPixelWidth(mode);
    CGDisplayModeRelease(mode);
    if wide == 0 {
        CGDisplayPixelsWide(id)
    } else {
        wide
    }
}

pub fn displays() -> Result<Vec<DisplayRecord>, String> {
    unsafe {
        let mut ids = [0u32; 16];
        let mut count = 0u32;
        let status = CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count);
        if status != 0 {
            return Err(format!("the active display list could not be read (CoreGraphics error {status})"));
        }
        if count == 0 {
            return Err("no displays".to_string());
        }
        let main = CGMainDisplayID();
        let mut out = Vec::with_capacity(count as usize);
        for &id in &ids[..count as usize] {
            let bounds = CGDisplayBounds(id);
            let pixels_wide = display_pixels_wide(id) as f64;
            let scale = if bounds.size.width > 0.0 { pixels_wide / bounds.size.width } else { 1.0 };
            out.push(DisplayRecord {
                index: 0,
                id: id.to_string(),
                origin_x: bounds.origin.x,
                origin_y: bounds.origin.y,
                width: bounds.size.width,
                height: bounds.size.height,
                scale: if scale >= 1.0 { scale } else { 1.0 },
                primary: id == main,
            });
        }
        Ok(out)
    }
}

unsafe fn image_rgba(image: CGImageRef) -> Result<(u32, u32, Vec<u8>), String> {
    let width = CGImageGetWidth(image);
    let height = CGImageGetHeight(image);
    let bytes_per_row = CGImageGetBytesPerRow(image);
    let bits_per_pixel = CGImageGetBitsPerPixel(image);
    if width == 0 || height == 0 {
        return Err("the display image is empty".to_string());
    }
    if bits_per_pixel != 32 {
        return Err(format!("the display image carries {bits_per_pixel} bits per pixel; 32 expected"));
    }
    let info = CGImageGetBitmapInfo(image);
    let little = info & BITMAP_BYTE_ORDER_MASK == BITMAP_BYTE_ORDER_32_LITTLE;
    let alpha = info & BITMAP_ALPHA_MASK;
    let alpha_last = alpha == ALPHA_PREMULTIPLIED_LAST || alpha == ALPHA_LAST || alpha == ALPHA_NONE_SKIP_LAST;
    let provider = CGImageGetDataProvider(image);
    if provider.is_null() {
        return Err("the display image has no data provider".to_string());
    }
    let data = CGDataProviderCopyData(provider);
    if data.is_null() {
        return Err("the display image data could not be copied".to_string());
    }
    let length = CFDataGetLength(data) as usize;
    let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(data), length);
    let needed = bytes_per_row.checked_mul(height).unwrap_or(usize::MAX);
    if length < needed || bytes_per_row < width * 4 {
        CFRelease(data);
        return Err(format!("the display image carries {length} bytes; {needed} expected"));
    }
    let (r, g, b) = match (little, alpha_last) {
        (true, false) => (2usize, 1usize, 0usize),
        (true, true) => (3, 2, 1),
        (false, false) => (1, 2, 3),
        (false, true) => (0, 1, 2),
    };
    let mut rgba = vec![0u8; width * height * 4];
    for row in 0..height {
        let source = &bytes[row * bytes_per_row..row * bytes_per_row + width * 4];
        let target = &mut rgba[row * width * 4..(row + 1) * width * 4];
        for x in 0..width {
            let s = &source[x * 4..x * 4 + 4];
            let t = &mut target[x * 4..x * 4 + 4];
            t[0] = s[r];
            t[1] = s[g];
            t[2] = s[b];
            t[3] = 255;
        }
    }
    CFRelease(data);
    Ok((width as u32, height as u32, rgba))
}

pub fn capture(display: &DisplayRecord) -> Result<(u32, u32, Vec<u8>), String> {
    let id: u32 = display.id.parse().map_err(|_| format!("no display {}", display.index))?;
    unsafe {
        let image = CGDisplayCreateImage(id);
        if image.is_null() {
            return Err(format!("no display {} image could be created", display.index));
        }
        let result = image_rgba(image);
        CGImageRelease(image);
        result
    }
}

unsafe fn app_facts(app: &AnyObject) -> (Option<String>, Option<String>, i32, isize) {
    let identity: Option<Retained<NSString>> = msg_send![app, bundleIdentifier];
    let name: Option<Retained<NSString>> = msg_send![app, localizedName];
    let pid: i32 = msg_send![app, processIdentifier];
    let policy: isize = msg_send![app, activationPolicy];
    (identity.map(|s| s.to_string()), name.map(|s| s.to_string()), pid, policy)
}

unsafe fn front_window_bounds(pid: i32) -> Option<BoundsRecord> {
    let list = CGWindowListCopyWindowInfo(WINDOW_LIST_OPTION_ON_SCREEN_ONLY | WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS, NULL_WINDOW_ID);
    if list.is_null() {
        return None;
    }
    let key_pid = cf_string("kCGWindowOwnerPID");
    let key_layer = cf_string("kCGWindowLayer");
    let key_bounds = cf_string("kCGWindowBounds");
    let mut found: Option<BoundsRecord> = None;
    let count = CFArrayGetCount(list);
    for i in 0..count {
        let dict = CFArrayGetValueAtIndex(list, i);
        if dict.is_null() {
            continue;
        }
        if cf_number_i64(CFDictionaryGetValue(dict, key_pid)) != Some(pid as i64) {
            continue;
        }
        if cf_number_i64(CFDictionaryGetValue(dict, key_layer)).unwrap_or(0) != 0 {
            continue;
        }
        let bounds = CFDictionaryGetValue(dict, key_bounds);
        if bounds.is_null() {
            continue;
        }
        let mut r = rect(0.0, 0.0, 0.0, 0.0);
        if CGRectMakeWithDictionaryRepresentation(bounds, &mut r) {
            found = Some(BoundsRecord { x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height });
            break;
        }
    }
    for key in [key_pid, key_layer, key_bounds] {
        if !key.is_null() {
            CFRelease(key);
        }
    }
    CFRelease(list);
    found
}

pub fn frontmost_application() -> ApplicationAnswer {
    autoreleasepool(|_| unsafe {
        let Some(workspace_class) = AnyClass::get(c"NSWorkspace") else {
            return ApplicationAnswer::refused("the application layer is not loaded");
        };
        let workspace: *mut AnyObject = msg_send![workspace_class, sharedWorkspace];
        if workspace.is_null() {
            return ApplicationAnswer::refused("the shared workspace is not available");
        }
        let app: *mut AnyObject = msg_send![&*workspace, frontmostApplication];
        if app.is_null() {
            return ApplicationAnswer::refused("no frontmost application");
        }
        let (identity, name, pid, _policy) = app_facts(&*app);
        let Some(identity) = identity.filter(|s| !s.is_empty()) else {
            return ApplicationAnswer::refused("the frontmost application has no bundle identifier");
        };
        let bounds = front_window_bounds(pid);
        ApplicationAnswer::found(identity, name, Some(pid as u32), None, bounds)
    })
}

fn parent_of(pid: i32) -> Option<i32> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut libc::proc_bsdinfo as *mut c_void, size) };
    if got != size {
        return None;
    }
    Some(info.pbi_ppid as i32)
}

pub fn own_terminal_application() -> ApplicationAnswer {
    autoreleasepool(|_| unsafe {
        let Some(running_class) = AnyClass::get(c"NSRunningApplication") else {
            return ApplicationAnswer::refused("the application layer is not loaded");
        };
        let mut pid = libc::getppid();
        for _ in 0..32 {
            if pid <= 1 {
                break;
            }
            let app: *mut AnyObject = msg_send![running_class, runningApplicationWithProcessIdentifier: pid];
            if !app.is_null() {
                let (identity, name, _, policy) = app_facts(&*app);
                if policy == ACTIVATION_POLICY_REGULAR {
                    if let Some(identity) = identity.filter(|s| !s.is_empty()) {
                        let bounds = front_window_bounds(pid);
                        return ApplicationAnswer::found(identity, name, Some(pid as u32), None, bounds);
                    }
                }
            }
            match parent_of(pid) {
                Some(parent) if parent != pid => pid = parent,
                _ => break,
            }
        }
        ApplicationAnswer::refused("no application with a bundle identifier above this process")
    })
}

pub fn cursor() -> Result<(f64, f64), String> {
    unsafe {
        let event = CGEventCreate(ptr::null_mut());
        if event.is_null() {
            return Err("the cursor position could not be read".to_string());
        }
        let location = CGEventGetLocation(event);
        CFRelease(event);
        Ok((location.x, location.y))
    }
}

unsafe fn source() -> Result<CGEventSourceRef, String> {
    let source = CGEventSourceCreate(EVENT_SOURCE_HID_SYSTEM_STATE);
    if source.is_null() {
        return Err("no event source".to_string());
    }
    Ok(source)
}

unsafe fn post(event: CGEventRef) -> Result<(), String> {
    if event.is_null() {
        return Err("the event could not be created".to_string());
    }
    CGEventPost(HID_EVENT_TAP, event);
    CFRelease(event);
    Ok(())
}

fn button_number(button: Button) -> u32 {
    match button {
        Button::Left => 0,
        Button::Right => 1,
        Button::Middle => 2,
    }
}

fn button_event(button: Button, down: bool) -> u32 {
    match (button, down) {
        (Button::Left, true) => 1,
        (Button::Left, false) => 2,
        (Button::Right, true) => 3,
        (Button::Right, false) => 4,
        (Button::Middle, true) => 25,
        (Button::Middle, false) => 26,
    }
}

fn drag_event(button: Button) -> u32 {
    match button {
        Button::Left => 6,
        Button::Right => 7,
        Button::Middle => 27,
    }
}

pub fn mouse_move(x: f64, y: f64) -> Result<(), String> {
    unsafe {
        let source = source()?;
        let event = CGEventCreateMouseEvent(source, EVENT_MOUSE_MOVED, point(x, y), 0);
        let posted = post(event);
        CFRelease(source);
        posted
    }
}

pub fn mouse_drag(button: Button, x: f64, y: f64) -> Result<(), String> {
    unsafe {
        let source = source()?;
        let event = CGEventCreateMouseEvent(source, drag_event(button), point(x, y), button_number(button));
        let posted = post(event);
        CFRelease(source);
        posted
    }
}

pub fn mouse_button(button: Button, down: bool, x: f64, y: f64, count: u32) -> Result<(), String> {
    unsafe {
        let source = source()?;
        let event = CGEventCreateMouseEvent(source, button_event(button, down), point(x, y), button_number(button));
        if !event.is_null() {
            CGEventSetIntegerValueField(event, MOUSE_EVENT_CLICK_STATE, count as i64);
        }
        let posted = post(event);
        CFRelease(source);
        posted
    }
}

pub fn scroll(delta_x: i32, delta_y: i32) -> Result<(), String> {
    unsafe {
        let source = source()?;
        let event = CGEventCreateScrollWheelEvent2(source, SCROLL_EVENT_UNIT_LINE, 2, -delta_y, -delta_x, 0);
        let posted = post(event);
        CFRelease(source);
        posted
    }
}

fn flags_of(active: &[Modifier]) -> u64 {
    let mut flags = FLAG_NON_COALESCED;
    for modifier in active {
        flags |= match modifier {
            Modifier::Shift => FLAG_SHIFT,
            Modifier::Control => FLAG_CONTROL,
            Modifier::Alt => FLAG_ALTERNATE,
            Modifier::Super => FLAG_COMMAND,
        };
    }
    flags
}

fn ansi_keycode(c: u8) -> Option<(u16, bool)> {
    let plain = |code: u16| Some((code, false));
    let shifted = |code: u16| Some((code, true));
    match c as char {
        'a' => plain(0x00),
        's' => plain(0x01),
        'd' => plain(0x02),
        'f' => plain(0x03),
        'h' => plain(0x04),
        'g' => plain(0x05),
        'z' => plain(0x06),
        'x' => plain(0x07),
        'c' => plain(0x08),
        'v' => plain(0x09),
        'b' => plain(0x0b),
        'q' => plain(0x0c),
        'w' => plain(0x0d),
        'e' => plain(0x0e),
        'r' => plain(0x0f),
        'y' => plain(0x10),
        't' => plain(0x11),
        '1' => plain(0x12),
        '2' => plain(0x13),
        '3' => plain(0x14),
        '4' => plain(0x15),
        '6' => plain(0x16),
        '5' => plain(0x17),
        '=' => plain(0x18),
        '9' => plain(0x19),
        '7' => plain(0x1a),
        '-' => plain(0x1b),
        '8' => plain(0x1c),
        '0' => plain(0x1d),
        ']' => plain(0x1e),
        'o' => plain(0x1f),
        'u' => plain(0x20),
        '[' => plain(0x21),
        'i' => plain(0x22),
        'p' => plain(0x23),
        'l' => plain(0x25),
        'j' => plain(0x26),
        '\'' => plain(0x27),
        'k' => plain(0x28),
        ';' => plain(0x29),
        '\\' => plain(0x2a),
        ',' => plain(0x2b),
        '/' => plain(0x2c),
        'n' => plain(0x2d),
        'm' => plain(0x2e),
        '.' => plain(0x2f),
        '`' => plain(0x32),
        'A'..='Z' => ansi_keycode(c.to_ascii_lowercase()).map(|(code, _)| (code, true)),
        '!' => shifted(0x12),
        '@' => shifted(0x13),
        '#' => shifted(0x14),
        '$' => shifted(0x15),
        '^' => shifted(0x16),
        '%' => shifted(0x17),
        '+' => shifted(0x18),
        '(' => shifted(0x19),
        '&' => shifted(0x1a),
        '_' => shifted(0x1b),
        '*' => shifted(0x1c),
        ')' => shifted(0x1d),
        '}' => shifted(0x1e),
        '{' => shifted(0x21),
        '"' => shifted(0x27),
        ':' => shifted(0x29),
        '|' => shifted(0x2a),
        '<' => shifted(0x2b),
        '?' => shifted(0x2c),
        '>' => shifted(0x2f),
        '~' => shifted(0x32),
        _ => None,
    }
}

fn keycode(key: KeyName) -> Result<(u16, bool), String> {
    let plain = |code: u16| Ok((code, false));
    match key {
        KeyName::Enter => plain(KEY_RETURN),
        KeyName::Tab => plain(KEY_TAB),
        KeyName::Escape => plain(KEY_ESCAPE),
        KeyName::Backspace => plain(KEY_BACKSPACE),
        KeyName::Delete => plain(KEY_FORWARD_DELETE),
        KeyName::Space => plain(KEY_SPACE),
        KeyName::Up => plain(KEY_UP),
        KeyName::Down => plain(KEY_DOWN),
        KeyName::Left => plain(KEY_LEFT),
        KeyName::Right => plain(KEY_RIGHT),
        KeyName::Home => plain(KEY_HOME),
        KeyName::End => plain(KEY_END),
        KeyName::PageUp => plain(KEY_PAGE_UP),
        KeyName::PageDown => plain(KEY_PAGE_DOWN),
        KeyName::Function(n) => FUNCTION_KEYS.get((n as usize).saturating_sub(1)).copied().map(|code| (code, false)).ok_or_else(|| format!("no such key: f{n}")),
        KeyName::Shift => plain(KEY_SHIFT),
        KeyName::Control => plain(KEY_CONTROL),
        KeyName::Alt => plain(KEY_OPTION),
        KeyName::Super => plain(KEY_COMMAND),
        KeyName::Char(c) => ansi_keycode(c).ok_or_else(|| format!("no such key: {}", c as char)),
    }
}

pub fn key(key: KeyName, down: bool, shifted: bool, active: &[Modifier]) -> Result<(), String> {
    let (code, symbol_shift) = keycode(key)?;
    let mut flags = flags_of(active);
    if shifted || symbol_shift {
        flags |= FLAG_SHIFT;
    }
    unsafe {
        let source = source()?;
        let event = CGEventCreateKeyboardEvent(source, code, down);
        if event.is_null() {
            CFRelease(source);
            return Err("the key event could not be created".to_string());
        }
        if let Some(c) = key.character(shifted) {
            let mut units = [0u16; 2];
            let encoded = c.encode_utf16(&mut units);
            CGEventKeyboardSetUnicodeString(event, encoded.len(), encoded.as_ptr());
        }
        CGEventSetFlags(event, flags);
        let posted = post(event);
        CFRelease(source);
        posted
    }
}

unsafe fn tap_code(source: CGEventSourceRef, code: u16) -> Result<(), String> {
    for down in [true, false] {
        let event = CGEventCreateKeyboardEvent(source, code, down);
        if !event.is_null() {
            CGEventSetFlags(event, FLAG_NON_COALESCED);
        }
        post(event)?;
    }
    Ok(())
}

pub fn type_char(c: char) -> Result<(), String> {
    unsafe {
        let source = source()?;
        let result = match c {
            '\n' | '\r' => tap_code(source, KEY_RETURN),
            '\t' => tap_code(source, KEY_TAB),
            _ => {
                let mut units = [0u16; 2];
                let encoded = c.encode_utf16(&mut units);
                let mut outcome = Ok(());
                for down in [true, false] {
                    let event = CGEventCreateKeyboardEvent(source, 0, down);
                    if !event.is_null() {
                        CGEventKeyboardSetUnicodeString(event, encoded.len(), encoded.as_ptr());
                        CGEventSetFlags(event, FLAG_NON_COALESCED);
                    }
                    outcome = post(event);
                    if outcome.is_err() {
                        break;
                    }
                }
                outcome
            }
        };
        CFRelease(source);
        result
    }
}
