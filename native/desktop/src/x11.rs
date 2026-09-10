use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as RandrConnectionExt;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as XprotoConnectionExt, ImageFormat, ImageOrder, Window, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT};
use x11rb::protocol::xtest::ConnectionExt as XtestConnectionExt;
use x11rb::rust_connection::RustConnection;

use crate::keys::{Button, KeyName, Modifier};
use crate::{ApplicationAnswer, BoundsRecord, DisplayRecord, PermissionsAnswer};

const CURRENT_TIME: u32 = 0;
const NO_DEVICE: u8 = 0;

fn wayland() -> bool {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    if session.eq_ignore_ascii_case("wayland") {
        return true;
    }
    std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn connect() -> Result<(RustConnection, usize), String> {
    if wayland() {
        return Err("a Wayland session: the X server, if any, sees only X clients, so the driver refuses rather than drive half a desktop".to_string());
    }
    if std::env::var_os("DISPLAY").is_none() {
        return Err("DISPLAY is not set: no X11 session to drive".to_string());
    }
    x11rb::connect(None).map_err(|error| format!("the X server could not be reached: {error}"))
}

pub fn permissions(_request: bool) -> PermissionsAnswer {
    if wayland() {
        return PermissionsAnswer {
            session: "wayland".to_string(),
            screen_capture: "not-required".to_string(),
            input: "not-required".to_string(),
            reason: Some("a Wayland session: the driver sees only X clients under XWayland and refuses rather than drive half a desktop".to_string()),
        };
    }
    match connect() {
        Ok(_) => PermissionsAnswer { session: "desktop".to_string(), screen_capture: "not-required".to_string(), input: "not-required".to_string(), reason: None },
        Err(text) => PermissionsAnswer { session: "no-display".to_string(), screen_capture: "not-required".to_string(), input: "not-required".to_string(), reason: Some(text) },
    }
}

fn root_of(conn: &RustConnection, screen: usize) -> Result<Window, String> {
    conn.setup().roots.get(screen).map(|s| s.root).ok_or_else(|| "the X server names no root window".to_string())
}

pub fn displays() -> Result<Vec<DisplayRecord>, String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    let monitors = conn
        .randr_get_monitors(root, true)
        .map_err(|e| format!("RandR monitors: {e}"))?
        .reply()
        .map_err(|e| format!("RandR monitors: {e}"))?;
    let mut out = Vec::new();
    for monitor in monitors.monitors {
        let name = conn
            .get_atom_name(monitor.name)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| String::from_utf8_lossy(&reply.name).to_string())
            .unwrap_or_else(|| format!("monitor-{}", monitor.name));
        out.push(DisplayRecord {
            index: 0,
            id: name,
            origin_x: monitor.x as f64,
            origin_y: monitor.y as f64,
            width: monitor.width as f64,
            height: monitor.height as f64,
            scale: 1.0,
            primary: monitor.primary,
        });
    }
    if out.is_empty() {
        let screen_record = &conn.setup().roots[screen];
        out.push(DisplayRecord {
            index: 0,
            id: "screen".to_string(),
            origin_x: 0.0,
            origin_y: 0.0,
            width: screen_record.width_in_pixels as f64,
            height: screen_record.height_in_pixels as f64,
            scale: 1.0,
            primary: true,
        });
    }
    Ok(out)
}

pub fn capture(display: &DisplayRecord) -> Result<(u32, u32, Vec<u8>), String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    let width = display.width.round() as u16;
    let height = display.height.round() as u16;
    if width == 0 || height == 0 {
        return Err(format!("no display {} area to capture", display.index));
    }
    let image = conn
        .get_image(ImageFormat::Z_PIXMAP, root, display.origin_x as i16, display.origin_y as i16, width, height, !0)
        .map_err(|e| format!("GetImage: {e}"))?
        .reply()
        .map_err(|e| format!("GetImage: {e}"))?;
    if image.depth != 24 && image.depth != 32 {
        return Err(format!("the root window has depth {}; 24 or 32 expected", image.depth));
    }
    let pixels = (width as usize) * (height as usize);
    if image.data.len() < pixels * 4 {
        return Err(format!("the image carries {} bytes; {} expected", image.data.len(), pixels * 4));
    }
    let lsb_first = conn.setup().image_byte_order == ImageOrder::LSB_FIRST;
    let mut rgba = vec![0u8; pixels * 4];
    for (i, pixel) in image.data.chunks_exact(4).take(pixels).enumerate() {
        let (r, g, b) = if lsb_first { (pixel[2], pixel[1], pixel[0]) } else { (pixel[1], pixel[2], pixel[3]) };
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = 255;
    }
    Ok((width as u32, height as u32, rgba))
}

fn atom(conn: &RustConnection, name: &str) -> Option<u32> {
    conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok().map(|r| r.atom)
}

fn property_bytes(conn: &RustConnection, window: Window, property: u32, kind: u32) -> Option<Vec<u8>> {
    let reply = conn.get_property(false, window, property, kind, 0, 4096).ok()?.reply().ok()?;
    if reply.value.is_empty() {
        return None;
    }
    Some(reply.value)
}

fn property_u32(conn: &RustConnection, window: Window, property: u32, kind: u32) -> Option<u32> {
    let reply = conn.get_property(false, window, property, kind, 0, 1).ok()?.reply().ok()?;
    let value = reply.value32()?.next();
    value
}

fn active_window(conn: &RustConnection, root: Window) -> Option<Window> {
    let active = atom(conn, "_NET_ACTIVE_WINDOW")?;
    let window = property_u32(conn, root, active, AtomEnum::WINDOW.into())?;
    if window == 0 {
        None
    } else {
        Some(window)
    }
}

fn window_bounds(conn: &RustConnection, window: Window, root: Window) -> Option<BoundsRecord> {
    let geometry = conn.get_geometry(window).ok()?.reply().ok()?;
    let translated = conn.translate_coordinates(window, root, 0, 0).ok()?.reply().ok()?;
    Some(BoundsRecord { x: translated.dst_x as f64, y: translated.dst_y as f64, width: geometry.width as f64, height: geometry.height as f64 })
}

fn application_of(conn: &RustConnection, window: Window, root: Window) -> ApplicationAnswer {
    let class_bytes = property_bytes(conn, window, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into());
    let class = class_bytes.as_ref().and_then(|bytes| {
        let mut parts = bytes.split(|b| *b == 0).filter(|part| !part.is_empty());
        let instance = parts.next().map(|p| String::from_utf8_lossy(p).to_string());
        let class = parts.next().map(|p| String::from_utf8_lossy(p).to_string());
        class.or(instance)
    });
    let Some(identity) = class else {
        return ApplicationAnswer::refused("the active window has no class");
    };
    let title = atom(conn, "_NET_WM_NAME")
        .and_then(|name| atom(conn, "UTF8_STRING").and_then(|utf8| property_bytes(conn, window, name, utf8)))
        .or_else(|| property_bytes(conn, window, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
        .map(|bytes| String::from_utf8_lossy(&bytes).trim_end_matches('\0').to_string());
    let pid = atom(conn, "_NET_WM_PID").and_then(|p| property_u32(conn, window, p, AtomEnum::CARDINAL.into()));
    ApplicationAnswer::found(identity.clone(), Some(identity), pid, title, window_bounds(conn, window, root))
}

pub fn frontmost_application() -> ApplicationAnswer {
    let (conn, screen) = match connect() {
        Ok(pair) => pair,
        Err(text) => return ApplicationAnswer::refused(&text),
    };
    let root = match root_of(&conn, screen) {
        Ok(root) => root,
        Err(text) => return ApplicationAnswer::refused(&text),
    };
    match active_window(&conn, root) {
        Some(window) => application_of(&conn, window, root),
        None => ApplicationAnswer::refused("no frontmost application"),
    }
}

pub fn own_terminal_application() -> ApplicationAnswer {
    ApplicationAnswer::refused("no terminal application identity on this platform")
}

pub fn cursor() -> Result<(f64, f64), String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    let pointer = conn.query_pointer(root).map_err(|e| format!("QueryPointer: {e}"))?.reply().map_err(|e| format!("QueryPointer: {e}"))?;
    Ok((pointer.root_x as f64, pointer.root_y as f64))
}

fn fake(conn: &RustConnection, root: Window, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
    conn.xtest_fake_input(kind, detail, CURRENT_TIME, root, x, y, NO_DEVICE).map_err(|e| format!("XTEST: {e}"))?;
    conn.flush().map_err(|e| format!("XTEST: {e}"))
}

pub fn mouse_move(x: f64, y: f64) -> Result<(), String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    fake(&conn, root, MOTION_NOTIFY_EVENT, 0, x.round() as i16, y.round() as i16)
}

pub fn mouse_drag(_button: Button, x: f64, y: f64) -> Result<(), String> {
    mouse_move(x, y)
}

fn button_number(button: Button) -> u8 {
    match button {
        Button::Left => 1,
        Button::Middle => 2,
        Button::Right => 3,
    }
}

pub fn mouse_button(button: Button, down: bool, _x: f64, _y: f64, _count: u32) -> Result<(), String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    fake(&conn, root, if down { BUTTON_PRESS_EVENT } else { BUTTON_RELEASE_EVENT }, button_number(button), 0, 0)
}

pub fn scroll(delta_x: i32, delta_y: i32) -> Result<(), String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    let vertical = if delta_y > 0 { 5 } else { 4 };
    for _ in 0..delta_y.unsigned_abs().min(100) {
        fake(&conn, root, BUTTON_PRESS_EVENT, vertical, 0, 0)?;
        fake(&conn, root, BUTTON_RELEASE_EVENT, vertical, 0, 0)?;
    }
    let horizontal = if delta_x > 0 { 7 } else { 6 };
    for _ in 0..delta_x.unsigned_abs().min(100) {
        fake(&conn, root, BUTTON_PRESS_EVENT, horizontal, 0, 0)?;
        fake(&conn, root, BUTTON_RELEASE_EVENT, horizontal, 0, 0)?;
    }
    Ok(())
}

const KEYSYM_RETURN: u32 = 0xff0d;
const KEYSYM_TAB: u32 = 0xff09;
const KEYSYM_ESCAPE: u32 = 0xff1b;
const KEYSYM_BACKSPACE: u32 = 0xff08;
const KEYSYM_DELETE: u32 = 0xffff;
const KEYSYM_SPACE: u32 = 0x0020;
const KEYSYM_UP: u32 = 0xff52;
const KEYSYM_DOWN: u32 = 0xff54;
const KEYSYM_LEFT: u32 = 0xff51;
const KEYSYM_RIGHT: u32 = 0xff53;
const KEYSYM_HOME: u32 = 0xff50;
const KEYSYM_END: u32 = 0xff57;
const KEYSYM_PAGE_UP: u32 = 0xff55;
const KEYSYM_PAGE_DOWN: u32 = 0xff56;
const KEYSYM_F1: u32 = 0xffbe;
const KEYSYM_SHIFT_L: u32 = 0xffe1;
const KEYSYM_CONTROL_L: u32 = 0xffe3;
const KEYSYM_ALT_L: u32 = 0xffe9;
const KEYSYM_SUPER_L: u32 = 0xffeb;

fn keysym_of(key: KeyName, shifted: bool) -> u32 {
    match key {
        KeyName::Enter => KEYSYM_RETURN,
        KeyName::Tab => KEYSYM_TAB,
        KeyName::Escape => KEYSYM_ESCAPE,
        KeyName::Backspace => KEYSYM_BACKSPACE,
        KeyName::Delete => KEYSYM_DELETE,
        KeyName::Space => KEYSYM_SPACE,
        KeyName::Up => KEYSYM_UP,
        KeyName::Down => KEYSYM_DOWN,
        KeyName::Left => KEYSYM_LEFT,
        KeyName::Right => KEYSYM_RIGHT,
        KeyName::Home => KEYSYM_HOME,
        KeyName::End => KEYSYM_END,
        KeyName::PageUp => KEYSYM_PAGE_UP,
        KeyName::PageDown => KEYSYM_PAGE_DOWN,
        KeyName::Function(n) => KEYSYM_F1 + (n as u32).saturating_sub(1),
        KeyName::Shift => KEYSYM_SHIFT_L,
        KeyName::Control => KEYSYM_CONTROL_L,
        KeyName::Alt => KEYSYM_ALT_L,
        KeyName::Super => KEYSYM_SUPER_L,
        KeyName::Char(c) => keysym_of_char(key.character(shifted).unwrap_or(c as char)),
    }
}

fn keysym_of_char(c: char) -> u32 {
    let code = c as u32;
    if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) {
        code
    } else {
        0x0100_0000 + code
    }
}

struct Keymap {
    min: u8,
    per: usize,
    syms: Vec<u32>,
}

fn keymap(conn: &RustConnection) -> Result<Keymap, String> {
    let setup = conn.setup();
    let min = setup.min_keycode;
    let max = setup.max_keycode;
    let reply = conn
        .get_keyboard_mapping(min, max - min + 1)
        .map_err(|e| format!("keyboard mapping: {e}"))?
        .reply()
        .map_err(|e| format!("keyboard mapping: {e}"))?;
    Ok(Keymap { min, per: reply.keysyms_per_keycode as usize, syms: reply.keysyms })
}

impl Keymap {
    fn keycode_of(&self, keysym: u32) -> Option<(u8, bool)> {
        if self.per == 0 {
            return None;
        }
        for (row, chunk) in self.syms.chunks(self.per).enumerate() {
            for (column, sym) in chunk.iter().enumerate() {
                if *sym == keysym {
                    return Some((self.min + row as u8, column % 2 == 1));
                }
            }
        }
        None
    }

    fn spare_keycode(&self) -> Option<u8> {
        if self.per == 0 {
            return None;
        }
        self.syms.chunks(self.per).enumerate().find(|(_, chunk)| chunk.iter().all(|sym| *sym == 0)).map(|(row, _)| self.min + row as u8)
    }
}

fn press_release(conn: &RustConnection, root: Window, keycode: u8, down: bool) -> Result<(), String> {
    fake(conn, root, if down { KEY_PRESS_EVENT } else { KEY_RELEASE_EVENT }, keycode, 0, 0)
}

fn with_remapped(conn: &RustConnection, map: &Keymap, keysym: u32, run: impl FnOnce(u8) -> Result<(), String>) -> Result<(), String> {
    let spare = map.spare_keycode().ok_or_else(|| format!("no keycode is free to type U+{keysym:04X}"))?;
    let mut row = vec![0u32; map.per];
    row[0] = keysym;
    conn.change_keyboard_mapping(1, spare, map.per as u8, &row).map_err(|e| format!("keyboard mapping: {e}"))?;
    conn.flush().map_err(|e| format!("keyboard mapping: {e}"))?;
    let outcome = run(spare);
    let empty = vec![0u32; map.per];
    let _ = conn.change_keyboard_mapping(1, spare, map.per as u8, &empty);
    let _ = conn.flush();
    outcome
}

pub fn key(key: KeyName, down: bool, shifted: bool, active: &[Modifier]) -> Result<(), String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    let map = keymap(&conn)?;
    let keysym = keysym_of(key, shifted);
    let (keycode, needs_shift) = match map.keycode_of(keysym) {
        Some(found) => found,
        None => {
            return with_remapped(&conn, &map, keysym, |code| {
                press_release(&conn, root, code, down)
            });
        }
    };
    let shift_code = map.keycode_of(KEYSYM_SHIFT_L).map(|(code, _)| code);
    let wants_shift = needs_shift && !active.contains(&Modifier::Shift) && key != KeyName::Shift;
    if wants_shift && down {
        if let Some(code) = shift_code {
            press_release(&conn, root, code, true)?;
        }
    }
    press_release(&conn, root, keycode, down)?;
    if wants_shift && !down {
        if let Some(code) = shift_code {
            press_release(&conn, root, code, false)?;
        }
    }
    Ok(())
}

pub fn type_char(c: char) -> Result<(), String> {
    let (conn, screen) = connect()?;
    let root = root_of(&conn, screen)?;
    let map = keymap(&conn)?;
    let keysym = match c {
        '\n' | '\r' => KEYSYM_RETURN,
        '\t' => KEYSYM_TAB,
        other => keysym_of_char(other),
    };
    match map.keycode_of(keysym) {
        Some((keycode, needs_shift)) => {
            let shift_code = if needs_shift { map.keycode_of(KEYSYM_SHIFT_L).map(|(code, _)| code) } else { None };
            if let Some(code) = shift_code {
                press_release(&conn, root, code, true)?;
            }
            press_release(&conn, root, keycode, true)?;
            press_release(&conn, root, keycode, false)?;
            if let Some(code) = shift_code {
                press_release(&conn, root, code, false)?;
            }
            Ok(())
        }
        None => with_remapped(&conn, &map, keysym, |code| {
            press_release(&conn, root, code, true)?;
            press_release(&conn, root, code, false)
        }),
    }
}
