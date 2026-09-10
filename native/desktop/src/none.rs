use crate::keys::{Button, KeyName, Modifier};
use crate::{ApplicationAnswer, DisplayRecord, PermissionsAnswer};

const UNSUPPORTED: &str = "unsupported";

pub fn permissions(_request: bool) -> PermissionsAnswer {
    PermissionsAnswer {
        session: "unknown".to_string(),
        screen_capture: "unknown".to_string(),
        input: "unknown".to_string(),
        reason: Some(UNSUPPORTED.to_string()),
    }
}

pub fn displays() -> Result<Vec<DisplayRecord>, String> {
    Err(UNSUPPORTED.to_string())
}

pub fn capture(_display: &DisplayRecord) -> Result<(u32, u32, Vec<u8>), String> {
    Err(UNSUPPORTED.to_string())
}

pub fn frontmost_application() -> ApplicationAnswer {
    ApplicationAnswer::refused(UNSUPPORTED)
}

pub fn own_terminal_application() -> ApplicationAnswer {
    ApplicationAnswer::refused(UNSUPPORTED)
}

pub fn cursor() -> Result<(f64, f64), String> {
    Err(UNSUPPORTED.to_string())
}

pub fn mouse_move(_x: f64, _y: f64) -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}

pub fn mouse_drag(_button: Button, _x: f64, _y: f64) -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}

pub fn mouse_button(_button: Button, _down: bool, _x: f64, _y: f64, _count: u32) -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}

pub fn scroll(_delta_x: i32, _delta_y: i32) -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}

pub fn key(_key: KeyName, _down: bool, _shifted: bool, _active: &[Modifier]) -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}

pub fn type_char(_c: char) -> Result<(), String> {
    Err(UNSUPPORTED.to_string())
}
