use std::ffi::c_void;
use std::mem::size_of;
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows::core::{Interface, BSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW, SRCCOPY,
};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Console::GetConsoleWindow;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME};
use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement, IUIAutomationElement9, IUIAutomationRangeValuePattern, IUIAutomationScrollItemPattern, IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern,
    IUIAutomationTogglePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern, ToggleState_On, TreeScope_Children, TreeScope_Subtree, UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId, UIA_FrameworkIdPropertyId,
    UIA_HasKeyboardFocusPropertyId, UIA_IsDialogPropertyId, UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId, UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId, UIA_NativeWindowHandlePropertyId, UIA_ProcessIdPropertyId,
    UIA_RangeValuePatternId, UIA_RangeValueValuePropertyId, UIA_ScrollItemPatternId, UIA_ScrollPatternId, UIA_SelectionItemIsSelectedPropertyId, UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ToggleToggleStatePropertyId, UIA_ValuePatternId,
    UIA_ValueValuePropertyId, UIA_CONTROLTYPE_ID,
};
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_HOME, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT,
    VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, WindowFromPoint, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, WHEEL_DELTA, MONITORINFOF_PRIMARY,
};

use crate::keys::{Button, KeyName, Modifier};
use crate::{ClickablePointAnswer, clipped, covered_words, hidden_by, number_words, same_frame, wheel_words, windows_role, ApplicationAnswer, BoundsRecord, DisplayRecord, PermissionsAnswer, ScrollAnswer, TreeAnswer, TreeElement, ValueAnswer, ELEMENT_NOT_UNIQUE, ROAD_ACTION, ROAD_WHEEL, SCROLL_SETTLE_MS, SCROLL_SETTLE_READS, SCROLL_UNSUPPORTED, SCROLL_WHEEL_LINES, SCROLL_WHEEL_STEPS, SECURE_NOT_READ_BACK, TREE_BUDGET_MS, TREE_VALUE_CHARS, VALUE_UNSUPPORTED, WHEEL_FAILED};

const OBSERVATION_DEPTH: u32 = 3;
const CLICKABLE_SCAN_STEP: f64 = 2.0;
const CLICKABLE_SCAN_ROWS: i32 = 40;
const OBSERVATION_COUNT: u32 = 200;

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
            work: rect_frame(info.monitorInfo.rcWork),
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

fn automation() -> Result<IUIAutomation, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|e| format!("UI Automation is unavailable: {}", e.message()))
    }
}

fn rect_frame(r: RECT) -> Option<BoundsRecord> {
    if r.right <= r.left || r.bottom <= r.top {
        return None;
    }
    Some(BoundsRecord { x: r.left as f64, y: r.top as f64, width: (r.right - r.left) as f64, height: (r.bottom - r.top) as f64 })
}

fn element_frame(element: &IUIAutomationElement) -> Option<BoundsRecord> {
    rect_frame(unsafe { element.CurrentBoundingRectangle() }.ok()?)
}

fn tree_cache(automation: &IUIAutomation) -> Result<IUIAutomationCacheRequest, String> {
    let cache = unsafe { automation.CreateCacheRequest() }.map_err(|e| format!("UI Automation refused a cache request: {}", e.message()))?;
    for property in [
        UIA_NamePropertyId, UIA_ControlTypePropertyId, UIA_LocalizedControlTypePropertyId, UIA_BoundingRectanglePropertyId, UIA_IsOffscreenPropertyId, UIA_HasKeyboardFocusPropertyId, UIA_IsPasswordPropertyId, UIA_FrameworkIdPropertyId, UIA_ProcessIdPropertyId,
        UIA_NativeWindowHandlePropertyId, UIA_IsDialogPropertyId,
    ] {
        let _ = unsafe { cache.AddProperty(property) };
    }
    for property in [UIA_ValueValuePropertyId, UIA_ToggleToggleStatePropertyId, UIA_RangeValueValuePropertyId, UIA_SelectionItemIsSelectedPropertyId] {
        let _ = unsafe { cache.AddProperty(property) };
    }
    for pattern in [UIA_ValuePatternId, UIA_ScrollPatternId, UIA_TogglePatternId, UIA_RangeValuePatternId, UIA_SelectionItemPatternId] {
        let _ = unsafe { cache.AddPattern(pattern) };
    }
    Ok(cache)
}

fn cached_value(element: &IUIAutomationElement) -> Option<String> {
    if let Ok(pattern) = unsafe { element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) } {
        if let Some(value) = unsafe { pattern.CachedValue() }.ok().map(|value| value.to_string()).filter(|value| !value.is_empty()) {
            return Some(value);
        }
    }
    if let Ok(pattern) = unsafe { element.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) } {
        return unsafe { pattern.CachedToggleState() }.ok().map(|state| if state == ToggleState_On { "1".to_string() } else { number_words(state.0 as f64) });
    }
    if let Ok(pattern) = unsafe { element.GetCachedPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId) } {
        return unsafe { pattern.CachedValue() }.ok().map(number_words);
    }
    if let Ok(pattern) = unsafe { element.GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) } {
        return unsafe { pattern.CachedIsSelected() }.ok().map(|flag| if flag.as_bool() { "1".to_string() } else { "0".to_string() });
    }
    None
}

fn tree_row(element: &IUIAutomationElement, depth: u32) -> TreeElement {
    let kind = unsafe { element.CachedControlType() }.unwrap_or(UIA_CONTROLTYPE_ID(0));
    let name = unsafe { element.CachedName() }.ok().map(|name| name.to_string()).filter(|name| !name.is_empty());
    let framework = unsafe { element.CachedFrameworkId() }.ok().map(|id| id.to_string()).unwrap_or_default();
    let password = unsafe { element.CachedIsPassword() }.map(|flag| flag.as_bool()).unwrap_or(false);
    let scrolls = unsafe { element.GetCachedPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }.is_ok();
    let dialog = element.cast::<IUIAutomationElement9>().ok().and_then(|newer| unsafe { newer.CachedIsDialog() }.ok()).map(|flag| flag.as_bool()).unwrap_or(false);
    let value = cached_value(element);
    let switch = unsafe { element.CachedLocalizedControlType() }.ok().is_some_and(|text| text.to_string().to_ascii_lowercase().contains("switch"));
    let role = windows_role(kind.0, &framework, password, scrolls, dialog, switch);
    let (title, value) = if role == "AXStaticText" && value.is_none() { (None, name) } else { (name, value) };
    let frame = unsafe { element.CachedBoundingRectangle() }.ok().and_then(rect_frame);
    let focused = unsafe { element.CachedHasKeyboardFocus() }.ok().map(|flag| flag.as_bool());
    let offscreen = unsafe { element.CachedIsOffscreen() }.ok().map(|flag| flag.as_bool());
    TreeElement { depth, role, title: title.map(|text| clipped(text, TREE_VALUE_CHARS)), value: value.map(|text| clipped(text, TREE_VALUE_CHARS)), frame, focused, nth: None, offscreen }
}

fn matching_element(candidate: &TreeElement, wanted: &TreeElement) -> bool {
    candidate.role == wanted.role && candidate.title == wanted.title && same_frame(&candidate.frame, &wanted.frame)
}

fn foreground_of(pid: i32) -> Result<HWND, String> {
    let front = unsafe { GetForegroundWindow() };
    if front.0.is_null() {
        return Err("the focused window is unavailable".to_string());
    }
    let mut owner = 0u32;
    unsafe { GetWindowThreadProcessId(front, Some(&mut owner)) };
    if owner as i32 != pid {
        return Err("the focused window is unavailable".to_string());
    }
    Ok(front)
}

fn unique_element(pid: i32, wanted: &TreeElement) -> Result<(IUIAutomation, IUIAutomationElement, IUIAutomationElement), String> {
    let automation = automation()?;
    let cache = tree_cache(&automation)?;
    let front = foreground_of(pid)?;
    let window = unsafe { automation.ElementFromHandleBuildCache(front, &cache) }.map_err(|e| format!("the focused window has no automation element: {}", e.message()))?;
    let condition = unsafe { automation.CreateTrueCondition() }.map_err(|e| format!("UI Automation refused a condition: {}", e.message()))?;
    let found = unsafe { window.FindAllBuildCache(TreeScope_Subtree, &condition, &cache) }.map_err(|e| format!("the window tree could not be read: {}", e.message()))?;
    let count = unsafe { found.Length() }.unwrap_or(0);
    let mut matches: Vec<IUIAutomationElement> = Vec::new();
    for index in 0..count {
        let Ok(element) = (unsafe { found.GetElement(index) }) else { continue };
        if matching_element(&tree_row(&element, 0), wanted) {
            matches.push(element);
        }
    }
    let index = match wanted.nth {
        Some(nth) => (nth as usize) < matches.len(),
        None => matches.len() == 1,
    };
    if !index {
        return Err(ELEMENT_NOT_UNIQUE.to_string());
    }
    Ok((automation, window, matches.remove(wanted.nth.unwrap_or(0) as usize)))
}

struct TreeWalk<'a> {
    walker: &'a IUIAutomationTreeWalker,
    cache: &'a IUIAutomationCacheRequest,
    started: Instant,
    budget: Duration,
    max_depth: u32,
    max_count: usize,
    depth_truncates: bool,
    elements: Vec<TreeElement>,
    truncated: bool,
    timed_out: bool,
}

impl TreeWalk<'_> {
    fn children_of(&self, element: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
        let mut list: Vec<IUIAutomationElement> = Vec::new();
        let mut next = unsafe { self.walker.GetFirstChildElementBuildCache(element, self.cache) }.ok();
        while let Some(child) = next {
            next = unsafe { self.walker.GetNextSiblingElementBuildCache(&child, self.cache) }.ok();
            list.push(child);
        }
        list
    }

    fn visit(&mut self, root: IUIAutomationElement, depth: u32) {
        let mut stack: Vec<(IUIAutomationElement, u32)> = vec![(root, depth)];
        while let Some((element, depth)) = stack.pop() {
            if self.elements.len() >= self.max_count || self.started.elapsed() > self.budget {
                self.truncated = true;
                self.timed_out |= self.started.elapsed() > self.budget;
                return;
            }
            self.elements.push(tree_row(&element, depth));
            if depth < self.max_depth {
                for child in self.children_of(&element).into_iter().rev() {
                    stack.push((child, depth + 1));
                }
            } else if self.depth_truncates && unsafe { self.walker.GetFirstChildElement(&element) }.is_ok() {
                self.truncated = true;
            }
        }
    }
}

fn top_level_windows(automation: &IUIAutomation, cache: &IUIAutomationCacheRequest, pid: i32) -> Result<Vec<IUIAutomationElement>, String> {
    let root = unsafe { automation.GetRootElement() }.map_err(|e| format!("the desktop has no automation element: {}", e.message()))?;
    let condition = unsafe { automation.CreateTrueCondition() }.map_err(|e| format!("UI Automation refused a condition: {}", e.message()))?;
    let found = unsafe { root.FindAllBuildCache(TreeScope_Children, &condition, cache) }.map_err(|e| format!("the desktop's windows could not be read: {}", e.message()))?;
    let front = unsafe { GetForegroundWindow() };
    let mut windows: Vec<IUIAutomationElement> = Vec::new();
    for index in 0..unsafe { found.Length() }.unwrap_or(0) {
        let Ok(element) = (unsafe { found.GetElement(index) }) else { continue };
        if unsafe { element.CachedProcessId() }.ok() != Some(pid) {
            continue;
        }
        if unsafe { element.CachedNativeWindowHandle() }.ok() == Some(front) {
            windows.insert(0, element);
        } else {
            windows.push(element);
        }
    }
    Ok(windows)
}

fn focused_row(automation: &IUIAutomation, walker: &IUIAutomationTreeWalker, cache: &IUIAutomationCacheRequest, pid: i32, within: Option<&IUIAutomationElement>) -> Option<TreeElement> {
    let focused = unsafe { automation.GetFocusedElementBuildCache(cache) }.ok()?;
    if unsafe { focused.CachedProcessId() }.ok() != Some(pid) {
        return None;
    }
    if let Some(window) = within {
        let mut cursor = Some(focused.clone());
        let mut inside = false;
        for _ in 0..64 {
            let Some(current) = cursor else { break };
            if unsafe { automation.CompareElements(&current, window) }.map(|flag| flag.as_bool()).unwrap_or(false) {
                inside = true;
                break;
            }
            cursor = unsafe { walker.GetParentElement(&current) }.ok();
        }
        if !inside {
            return None;
        }
    }
    Some(tree_row(&focused, 0))
}

fn tree_answer(walk: TreeWalk, focused: Option<TreeElement>, scope: &str, observation: bool) -> TreeAnswer {
    let web_content = if observation { None } else if walk.elements.iter().any(|element| element.role.starts_with("AXWebArea")) { Some("available") } else if walk.truncated { None } else { Some("absent") };
    let reason = if walk.timed_out { Some(format!("the walk stopped after {} ms", TREE_BUDGET_MS)) } else { None };
    TreeAnswer { elements: walk.elements, focused, truncated: walk.truncated, reason, scope: Some(scope.to_string()), web_content: web_content.map(str::to_string), web_accessibility: None }
}

pub fn accessibility_tree(pid: i32, max_depth: u32, max_count: u32, scope: &str, observation: bool) -> TreeAnswer {
    let _dpi = DpiScope::enter();
    let automation = match automation() {
        Ok(automation) => automation,
        Err(text) => return TreeAnswer::refused(&text),
    };
    let cache = match tree_cache(&automation) {
        Ok(cache) => cache,
        Err(text) => return TreeAnswer::refused(&text),
    };
    let walker = match unsafe { automation.ControlViewWalker() } {
        Ok(walker) => walker,
        Err(error) => return TreeAnswer::refused(&format!("UI Automation refused a tree walker: {}", error.message())),
    };
    let started = Instant::now();
    let budget = Duration::from_millis(TREE_BUDGET_MS);
    let front = foreground_of(pid).ok().and_then(|handle| unsafe { automation.ElementFromHandleBuildCache(handle, &cache) }.ok());
    if observation {
        let Some(window) = front else {
            return TreeAnswer::refused("the focused window is unavailable");
        };
        let mut walk = TreeWalk { walker: &walker, cache: &cache, started, budget, max_depth: OBSERVATION_DEPTH, max_count: OBSERVATION_COUNT as usize, depth_truncates: false, elements: Vec::new(), truncated: false, timed_out: false };
        walk.visit(window.clone(), 0);
        let focused = focused_row(&automation, &walker, &cache, pid, Some(&window));
        return tree_answer(walk, focused, "window", true);
    }
    let windows = if scope == "window" {
        let Some(window) = front else {
            return TreeAnswer::refused("the focused window is unavailable — use scope:app to read the application's tree or take a screenshot");
        };
        vec![window]
    } else {
        match top_level_windows(&automation, &cache, pid) {
            Ok(windows) => windows,
            Err(text) => return TreeAnswer::refused(&text),
        }
    };
    if windows.is_empty() {
        return TreeAnswer::refused("the application answered no accessibility element (no such process, or it is not responding)");
    }
    let name = process_image(pid as u32).map(|image| identity_of(&image).1);
    let mut walk = TreeWalk { walker: &walker, cache: &cache, started, budget, max_depth, max_count: max_count as usize, depth_truncates: true, elements: vec![TreeElement { depth: 0, role: "AXApplication".to_string(), title: name, value: None, frame: None, focused: None, nth: None, offscreen: None }], truncated: false, timed_out: false };
    for window in windows {
        if walk.truncated {
            break;
        }
        if max_depth < 1 {
            walk.truncated = true;
            break;
        }
        walk.visit(window, 1);
    }
    let focused = focused_row(&automation, &walker, &cache, pid, None);
    tree_answer(walk, focused, scope, false)
}

fn settled_frame(element: &IUIAutomationElement, before: Option<BoundsRecord>) -> Option<BoundsRecord> {
    let mut frame = before;
    let mut moved = false;
    for _ in 0..SCROLL_SETTLE_READS {
        sleep(Duration::from_millis(SCROLL_SETTLE_MS));
        let next = element_frame(element);
        let changed = !same_frame(&next, &frame);
        frame = next;
        if moved && !changed {
            break;
        }
        moved |= changed;
    }
    frame
}

fn pid_under(x: f64, y: f64) -> Option<i32> {
    let window = unsafe { WindowFromPoint(POINT { x: x.round() as i32, y: y.round() as i32 }) };
    if window.0.is_null() {
        return None;
    }
    let mut owner = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
    if owner == 0 { None } else { Some(owner as i32) }
}

fn wheel_into_view(pid: i32, window: &IUIAutomationElement, element: &IUIAutomationElement, started: Instant, budget: Duration) -> ScrollAnswer {
    let Some(viewport) = element_frame(window) else {
        return ScrollAnswer { scrolled: false, road: None, frame: element_frame(element), reason: Some(format!("{WHEEL_FAILED}: the window's frame is unavailable")) };
    };
    let mut frame = element_frame(element);
    let mut at: Option<(f64, f64)> = None;
    for _ in 0..SCROLL_WHEEL_STEPS {
        let Some(current) = frame.as_ref() else { break };
        let (dx, dy) = hidden_by(current, &viewport);
        if dx == 0 && dy == 0 {
            return ScrollAnswer { scrolled: true, road: Some(ROAD_WHEEL.to_string()), frame, reason: at.map(|(x, y)| wheel_words(x, y)) };
        }
        if started.elapsed() > budget {
            break;
        }
        let x = (current.x + current.width / 2.0).clamp(viewport.x + 2.0, viewport.x + viewport.width - 2.0);
        let y = viewport.y + viewport.height / 2.0;
        if pid_under(x, y).is_some_and(|owner| owner != pid) {
            return ScrollAnswer { scrolled: false, road: None, frame, reason: Some(covered_words(x, y)) };
        }
        if mouse_move(x, y).and_then(|_| scroll(dx * SCROLL_WHEEL_LINES, dy * SCROLL_WHEEL_LINES)).is_err() {
            break;
        }
        at = Some((x, y));
        frame = settled_frame(element, frame);
    }
    ScrollAnswer { scrolled: false, road: None, frame, reason: Some(WHEEL_FAILED.to_string()) }
}

pub fn scroll_to_visible(pid: i32, wanted: &TreeElement, wheel: bool) -> Result<ScrollAnswer, String> {
    let _dpi = DpiScope::enter();
    let started = Instant::now();
    let budget = Duration::from_millis(TREE_BUDGET_MS);
    let (_automation, window, element) = unique_element(pid, wanted)?;
    let pattern: Option<IUIAutomationScrollItemPattern> = unsafe { element.GetCurrentPatternAs(UIA_ScrollItemPatternId) }.ok();
    Ok(match pattern {
        Some(pattern) => {
            let before = element_frame(&element);
            match unsafe { pattern.ScrollIntoView() } {
                Ok(()) => ScrollAnswer { scrolled: true, road: Some(ROAD_ACTION.to_string()), frame: settled_frame(&element, before), reason: None },
                Err(error) => ScrollAnswer { scrolled: false, road: None, frame: before, reason: Some(format!("{SCROLL_UNSUPPORTED}; the pattern answered {}", error.message())) },
            }
        }
        None if wheel => wheel_into_view(pid, &window, &element, started, budget),
        None => ScrollAnswer { scrolled: false, road: None, frame: element_frame(&element), reason: Some(SCROLL_UNSUPPORTED.to_string()) },
    })
}

pub fn clickable_point(pid: i32, wanted: &TreeElement) -> Result<ClickablePointAnswer, String> {
    let _dpi = DpiScope::enter();
    let (automation, _window, element) = unique_element(pid, wanted)?;
    let mut point = POINT::default();
    match unsafe { element.GetClickablePoint(&mut point) } {
        Ok(got) if got.as_bool() => return Ok(ClickablePointAnswer { x: Some(point.x as f64), y: Some(point.y as f64), road: Some("native".to_string()), reason: None }),
        Ok(_) => {}
        Err(error) => return Ok(ClickablePointAnswer { x: None, y: None, road: None, reason: Some(format!("the clickable point could not be read: {}", error.message())) }),
    }
    let Some(frame) = element_frame(&element) else {
        return Ok(ClickablePointAnswer { x: None, y: None, road: None, reason: Some("no clickable point and no frame".to_string()) });
    };
    let rows = ((frame.height / CLICKABLE_SCAN_STEP).ceil() as i32).clamp(1, CLICKABLE_SCAN_ROWS);
    let row_y = |row: i32| (frame.y + (row as f64) * frame.height / (rows as f64)).min(frame.y + frame.height - 1.0).max(frame.y).round() as i32;
    let hits = |x: i32, y: i32| -> bool {
        let Ok(hit) = (unsafe { automation.ElementFromPoint(POINT { x, y }) }) else { return false };
        unsafe { automation.CompareElements(&hit, &element) }.map(|flag| flag.as_bool()).unwrap_or(false)
    };
    for row in 0..=rows {
        let y = row_y(row);
        for column in [0.5, 0.25, 0.75] {
            let x = (frame.x + frame.width * column).round() as i32;
            if !hits(x, y) {
                continue;
            }
            let mut last = row;
            while last < rows && hits(x, row_y(last + 1)) {
                last += 1;
            }
            let middle = row_y((row + last) / 2);
            return Ok(ClickablePointAnswer { x: Some(x as f64), y: Some(middle as f64), road: Some("hit-test".to_string()), reason: None });
        }
    }
    Ok(ClickablePointAnswer { x: None, y: None, road: None, reason: Some("UI Automation reports no clickable point for it and no point of its frame hits it (covered, or scrolled out of its pane)".to_string()) })
}

pub fn set_value(pid: i32, wanted: &TreeElement, text: &str) -> Result<ValueAnswer, String> {
    let _dpi = DpiScope::enter();
    let (_automation, _window, element) = unique_element(pid, wanted)?;
    let secure = wanted.role.contains("Secure") || unsafe { element.CurrentIsPassword() }.map(|flag| flag.as_bool()).unwrap_or(false);
    let pattern: Option<IUIAutomationValuePattern> = unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }.ok();
    let Some(pattern) = pattern else {
        return Ok(ValueAnswer { set: false, value: None, reason: Some(VALUE_UNSUPPORTED.to_string()) });
    };
    let read = || unsafe { pattern.CurrentValue() }.ok().map(|value| value.to_string()).filter(|value| !value.is_empty());
    let current = || if secure { None } else { read() };
    if unsafe { pattern.CurrentIsReadOnly() }.map(|flag| flag.as_bool()).unwrap_or(true) {
        return Ok(ValueAnswer { set: false, value: current(), reason: Some(VALUE_UNSUPPORTED.to_string()) });
    }
    if let Err(error) = unsafe { pattern.SetValue(&BSTR::from(text)) } {
        return Ok(ValueAnswer { set: false, value: current(), reason: Some(format!("{VALUE_UNSUPPORTED}; the pattern answered {}", error.message())) });
    }
    if secure {
        return Ok(ValueAnswer { set: true, value: None, reason: Some(SECURE_NOT_READ_BACK.to_string()) });
    }
    let wanted_value = if text.is_empty() { None } else { Some(text.to_string()) };
    let mut value = read();
    for _ in 0..SCROLL_SETTLE_READS {
        if value == wanted_value {
            break;
        }
        sleep(Duration::from_millis(SCROLL_SETTLE_MS));
        value = read();
    }
    Ok(ValueAnswer { set: true, value, reason: None })
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
