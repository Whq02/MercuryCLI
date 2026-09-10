use std::ffi::c_void;
use std::mem::size_of;

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW, MONITORINFOF_PRIMARY, SRCCOPY,
};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Console::GetConsoleWindow;
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME};
use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_HOME, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT,
    VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, WHEEL_DELTA,
};

use crate::keys::{Button, KeyName, Modifier};
use crate::{ApplicationAnswer, BoundsRecord, DisplayRecord, PermissionsAnswer};

struct DpiScope {
    previous: DPI_AWARENESS_CONTEXT,
}

impl DpiScope {
    fn enter() -> DpiScope {
        let previous = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        DpiScope { previous }
    }
}

impl Drop for DpiScope {
    fn drop(&mut self) {
        if !self.previous.0.is_null() {
            unsafe {
                SetThreadDpiAwarenessContext(self.previous);
            }
        }
    }
}

fn wide_to_string(units: &[u16]) -> String {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

fn last_error(what: &str) -> String {
    format!("{what} failed: {}", windows::core::Error::from_win32().message())
}

fn desktop_name() -> Option<String> {
    unsafe {
        let desktop = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS).ok()?;
        let handle = HANDLE(desktop.0);
        let mut name = [0u16; 128];
        let mut needed = 0u32;
        let read = GetUserObjectInformationW(handle, UOI_NAME, Some(name.as_mut_ptr() as *mut c_void), (name.len() * 2) as u32, Some(&mut needed));
        let _ = CloseDesktop(desktop);
        read.ok()?;
        Some(wide_to_string(&name))
    }
}

fn elevated() -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let read = GetTokenInformation(token, TokenElevation, Some(&mut elevation as *mut TOKEN_ELEVATION as *mut c_void), size_of::<TOKEN_ELEVATION>() as u32, &mut returned);
        let _ = CloseHandle(token);
        read.ok()?;
        Some(elevation.TokenIsElevated != 0)
    }
}

pub fn permissions(_request: bool) -> PermissionsAnswer {
    let _dpi = DpiScope::enter();
    let mut session_id = 0u32;
    let in_session = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id).is_ok() };
    let (session, mut reasons): (&str, Vec<String>) = if !in_session || session_id == 0 {
        ("service", vec!["this process runs in session 0 (a service), which has no interactive desktop".to_string()])
    } else {
        match desktop_name() {
            Some(name) if name.eq_ignore_ascii_case("Default") => ("desktop", Vec::new()),
            Some(name) => ("locked", vec![format!("the input desktop is {name}, not the interactive Default desktop (locked, or a secure desktop in front)")]),
            None => ("no-display", vec!["the input desktop could not be opened (no interactive window station, or a disconnected session)".to_string()]),
        }
    };
    match elevated() {
        Some(true) => reasons.push("this process is elevated: it can drive elevated and ordinary windows alike".to_string()),
        Some(false) => reasons.push("this process is not elevated: Windows drops input into a window that runs elevated".to_string()),
        None => {}
    }
    PermissionsAnswer {
        session: session.to_string(),
        screen_capture: "not-required".to_string(),
        input: "not-required".to_string(),
        reason: if reasons.is_empty() { None } else { Some(reasons.join("; ")) },
    }
}

unsafe extern "system" fn collect_monitor(monitor: HMONITOR, _hdc: HDC, _rect: *mut RECT, data: LPARAM) -> windows::core::BOOL {
    let out = &mut *(data.0 as *mut Vec<DisplayRecord>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
        let r = info.monitorInfo.rcMonitor;
        out.push(DisplayRecord {
            index: 0,
            id: wide_to_string(&info.szDevice),
            origin_x: r.left as f64,
            origin_y: r.top as f64,
            width: (r.right - r.left) as f64,
            height: (r.bottom - r.top) as f64,
            scale: 1.0,
            primary: (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0,
        });
    }
    true.into()
}

pub fn displays() -> Result<Vec<DisplayRecord>, String> {
    let _dpi = DpiScope::enter();
    let mut out: Vec<DisplayRecord> = Vec::new();
    let ok = unsafe { EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut out as *mut Vec<DisplayRecord> as isize)) };
    if !ok.as_bool() {
        return Err(last_error("EnumDisplayMonitors"));
    }
    if out.is_empty() {
        return Err("no displays".to_string());
    }
    Ok(out)
}

pub fn capture(display: &DisplayRecord) -> Result<(u32, u32, Vec<u8>), String> {
    let _dpi = DpiScope::enter();
    let width = display.width.round() as i32;
    let height = display.height.round() as i32;
    if width <= 0 || height <= 0 {
        return Err(format!("no display {} area to capture", display.index));
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err(last_error("GetDC"));
        }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let blit = BitBlt(memory, 0, 0, width, height, Some(screen), display.origin_x as i32, display.origin_y as i32, SRCCOPY | CAPTUREBLT);
        SelectObject(memory, previous);
        let mut result: Result<(u32, u32, Vec<u8>), String> = Err(String::new());
        if let Err(error) = blit {
            result = Err(format!("BitBlt failed: {}", error.message()));
        } else {
            let mut info = BITMAPINFO::default();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut bgra = vec![0u8; (width as usize) * (height as usize) * 4];
            let lines = GetDIBits(memory, bitmap, 0, height as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
            if lines != height {
                result = Err(format!("GetDIBits copied {lines} of {height} rows: {}", last_error("GetDIBits")));
            } else {
                for pixel in bgra.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                    pixel[3] = 255;
                }
                result = Ok((width as u32, height as u32, bgra));
            }
        }
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        result
    }
}

fn process_image(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut name = [0u16; 1024];
        let mut length = name.len() as u32;
        let read = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(name.as_mut_ptr()), &mut length);
        let _ = CloseHandle(process);
        read.ok()?;
        Some(String::from_utf16_lossy(&name[..length as usize]))
    }
}

fn identity_of(image: &str) -> (String, String) {
    let base = image.rsplit(['\\', '/']).next().unwrap_or(image);
    let identity = base.to_ascii_lowercase();
    let name = match base.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => base.to_string(),
    };
    (identity, name)
}

fn window_bounds(window: HWND) -> Option<BoundsRecord> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(window, &mut r).ok()? };
    Some(BoundsRecord { x: r.left as f64, y: r.top as f64, width: (r.right - r.left) as f64, height: (r.bottom - r.top) as f64 })
}

fn window_title(window: HWND) -> Option<String> {
    let mut text = [0u16; 512];
    let length = unsafe { GetWindowTextW(window, &mut text) };
    if length <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&text[..length as usize]))
}

fn application_of(window: HWND) -> ApplicationAnswer {
    if window.0.is_null() {
        return ApplicationAnswer::refused("no frontmost window");
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    if pid == 0 {
        return ApplicationAnswer::refused("the frontmost window has no owner process");
    }
    let Some(image) = process_image(pid) else {
        return ApplicationAnswer::refused("the frontmost window's owner process could not be read");
    };
    let (identity, name) = identity_of(&image);
    ApplicationAnswer::found(identity, Some(name), Some(pid), window_title(window), window_bounds(window))
}

pub fn frontmost_application() -> ApplicationAnswer {
    let _dpi = DpiScope::enter();
    application_of(unsafe { GetForegroundWindow() })
}

pub fn own_terminal_application() -> ApplicationAnswer {
    let _dpi = DpiScope::enter();
    if std::env::var_os("WT_SESSION").is_some() {
        let console = unsafe { GetConsoleWindow() };
        let bounds = if console.0.is_null() { None } else { window_bounds(console) };
        return ApplicationAnswer::found("windowsterminal.exe".to_string(), Some("WindowsTerminal".to_string()), None, None, bounds);
    }
    let console = unsafe { GetConsoleWindow() };
    if console.0.is_null() {
        return ApplicationAnswer::refused("no console window owns this process");
    }
    application_of(console)
}

pub fn cursor() -> Result<(f64, f64), String> {
    let _dpi = DpiScope::enter();
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).map_err(|e| format!("GetCursorPos failed: {}", e.message()))? };
    Ok((p.x as f64, p.y as f64))
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(last_error("SendInput"));
    }
    Ok(())
}

fn mouse_input(dx: i32, dy: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn absolute(x: f64, y: f64) -> (i32, i32) {
    let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) } as f64;
    let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) } as f64;
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1) as f64;
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1) as f64;
    let nx = ((x - left) * 65535.0 / width).round().clamp(0.0, 65535.0) as i32;
    let ny = ((y - top) * 65535.0 / height).round().clamp(0.0, 65535.0) as i32;
    (nx, ny)
}

pub fn mouse_move(x: f64, y: f64) -> Result<(), String> {
    let _dpi = DpiScope::enter();
    let (nx, ny) = absolute(x, y);
    send(&[mouse_input(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
}

pub fn mouse_drag(_button: Button, x: f64, y: f64) -> Result<(), String> {
    mouse_move(x, y)
}

fn button_flag(button: Button, down: bool) -> MOUSE_EVENT_FLAGS {
    match (button, down) {
        (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (Button::Left, false) => MOUSEEVENTF_LEFTUP,
        (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
        (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    }
}

pub fn mouse_button(button: Button, down: bool, _x: f64, _y: f64, _count: u32) -> Result<(), String> {
    let _dpi = DpiScope::enter();
    send(&[mouse_input(0, 0, 0, button_flag(button, down))])
}

pub fn scroll(delta_x: i32, delta_y: i32) -> Result<(), String> {
    let _dpi = DpiScope::enter();
    let mut inputs: Vec<INPUT> = Vec::new();
    if delta_y != 0 {
        inputs.push(mouse_input(0, 0, ((-delta_y) * WHEEL_DELTA as i32) as u32, MOUSEEVENTF_WHEEL));
    }
    if delta_x != 0 {
        inputs.push(mouse_input(0, 0, (delta_x * WHEEL_DELTA as i32) as u32, MOUSEEVENTF_HWHEEL));
    }
    if inputs.is_empty() {
        return Ok(());
    }
    send(&inputs)
}

fn key_input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn virtual_key(key: KeyName) -> Result<(VIRTUAL_KEY, bool), String> {
    let plain = |vk: VIRTUAL_KEY| Ok((vk, false));
    match key {
        KeyName::Enter => plain(VK_RETURN),
        KeyName::Tab => plain(VK_TAB),
        KeyName::Escape => plain(VK_ESCAPE),
        KeyName::Backspace => plain(VK_BACK),
        KeyName::Delete => plain(VK_DELETE),
        KeyName::Space => plain(VK_SPACE),
        KeyName::Up => plain(VK_UP),
        KeyName::Down => plain(VK_DOWN),
        KeyName::Left => plain(VK_LEFT),
        KeyName::Right => plain(VK_RIGHT),
        KeyName::Home => plain(VK_HOME),
        KeyName::End => plain(VK_END),
        KeyName::PageUp => plain(VK_PRIOR),
        KeyName::PageDown => plain(VK_NEXT),
        KeyName::Function(n) => plain(VIRTUAL_KEY(VK_F1.0 + (n as u16).saturating_sub(1))),
        KeyName::Shift => plain(VK_SHIFT),
        KeyName::Control => plain(VK_CONTROL),
        KeyName::Alt => plain(VK_MENU),
        KeyName::Super => plain(VK_LWIN),
        KeyName::Char(c) => {
            let scan = unsafe { VkKeyScanW(c as u16) };
            if scan == -1 {
                return Err(format!("no such key: {}", c as char));
            }
            let vk = VIRTUAL_KEY((scan & 0xff) as u16);
            let needs_shift = (scan >> 8) & 1 == 1;
            Ok((vk, needs_shift))
        }
    }
}

pub fn key(key: KeyName, down: bool, shifted: bool, active: &[Modifier]) -> Result<(), String> {
    let _dpi = DpiScope::enter();
    let (vk, symbol_shift) = virtual_key(key)?;
    let wants_shift = (shifted || symbol_shift) && !active.contains(&Modifier::Shift) && key != KeyName::Shift;
    let mut inputs: Vec<INPUT> = Vec::new();
    if wants_shift && down {
        inputs.push(key_input(VK_SHIFT, 0, KEYBD_EVENT_FLAGS(0)));
    }
    inputs.push(key_input(vk, 0, if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP }));
    if wants_shift && !down {
        inputs.push(key_input(VK_SHIFT, 0, KEYEVENTF_KEYUP));
    }
    send(&inputs)
}

pub fn type_char(c: char) -> Result<(), String> {
    let _dpi = DpiScope::enter();
    match c {
        '\n' | '\r' => send(&[key_input(VK_RETURN, 0, KEYBD_EVENT_FLAGS(0)), key_input(VK_RETURN, 0, KEYEVENTF_KEYUP)]),
        '\t' => send(&[key_input(VK_TAB, 0, KEYBD_EVENT_FLAGS(0)), key_input(VK_TAB, 0, KEYEVENTF_KEYUP)]),
        _ => {
            let mut units = [0u16; 2];
            let encoded = c.encode_utf16(&mut units);
            let mut inputs: Vec<INPUT> = Vec::with_capacity(encoded.len() * 2);
            for unit in encoded.iter() {
                inputs.push(key_input(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE));
                inputs.push(key_input(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            send(&inputs)
        }
    }
}
