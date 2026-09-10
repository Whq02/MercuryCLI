#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    pub fn parse(name: &str) -> Result<Button, String> {
        match name {
            "left" => Ok(Button::Left),
            "right" => Ok(Button::Right),
            "middle" => Ok(Button::Middle),
            other => Err(format!("no such button: {other}")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Button::Left => "left",
            Button::Right => "right",
            Button::Middle => "middle",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Modifier {
    Shift,
    Control,
    Alt,
    Super,
}

impl Modifier {
    pub fn parse(name: &str) -> Result<Modifier, String> {
        match name {
            "shift" => Ok(Modifier::Shift),
            "control" => Ok(Modifier::Control),
            "alt" => Ok(Modifier::Alt),
            "super" => Ok(Modifier::Super),
            other => Err(format!("no such modifier: {other}")),
        }
    }

    pub fn key(self) -> KeyName {
        match self {
            Modifier::Shift => KeyName::Shift,
            Modifier::Control => KeyName::Control,
            Modifier::Alt => KeyName::Alt,
            Modifier::Super => KeyName::Super,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum KeyName {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Function(u8),
    Shift,
    Control,
    Alt,
    Super,
    Char(u8),
}

pub struct ParsedKey {
    pub key: KeyName,
    pub shifted: bool,
}

impl KeyName {
    pub fn parse(name: &str) -> Result<ParsedKey, String> {
        let plain = |key: KeyName| Ok(ParsedKey { key, shifted: false });
        match name {
            "enter" => plain(KeyName::Enter),
            "tab" => plain(KeyName::Tab),
            "escape" => plain(KeyName::Escape),
            "backspace" => plain(KeyName::Backspace),
            "delete" => plain(KeyName::Delete),
            "space" | " " => plain(KeyName::Space),
            "up" => plain(KeyName::Up),
            "down" => plain(KeyName::Down),
            "left" => plain(KeyName::Left),
            "right" => plain(KeyName::Right),
            "home" => plain(KeyName::Home),
            "end" => plain(KeyName::End),
            "pageup" => plain(KeyName::PageUp),
            "pagedown" => plain(KeyName::PageDown),
            "shift" => plain(KeyName::Shift),
            "control" => plain(KeyName::Control),
            "alt" => plain(KeyName::Alt),
            "super" => plain(KeyName::Super),
            _ => {
                if let Some(number) = name.strip_prefix('f') {
                    if let Ok(n) = number.parse::<u8>() {
                        if (1..=12).contains(&n) {
                            return plain(KeyName::Function(n));
                        }
                    }
                }
                let bytes = name.as_bytes();
                if bytes.len() == 1 && bytes[0] > 0x20 && bytes[0] < 0x7f {
                    let c = bytes[0];
                    if c.is_ascii_uppercase() {
                        return Ok(ParsedKey { key: KeyName::Char(c.to_ascii_lowercase()), shifted: true });
                    }
                    return plain(KeyName::Char(c));
                }
                Err(format!("no such key: {name}"))
            }
        }
    }

    pub fn name(self) -> String {
        match self {
            KeyName::Enter => "enter".to_string(),
            KeyName::Tab => "tab".to_string(),
            KeyName::Escape => "escape".to_string(),
            KeyName::Backspace => "backspace".to_string(),
            KeyName::Delete => "delete".to_string(),
            KeyName::Space => "space".to_string(),
            KeyName::Up => "up".to_string(),
            KeyName::Down => "down".to_string(),
            KeyName::Left => "left".to_string(),
            KeyName::Right => "right".to_string(),
            KeyName::Home => "home".to_string(),
            KeyName::End => "end".to_string(),
            KeyName::PageUp => "pageup".to_string(),
            KeyName::PageDown => "pagedown".to_string(),
            KeyName::Function(n) => format!("f{n}"),
            KeyName::Shift => "shift".to_string(),
            KeyName::Control => "control".to_string(),
            KeyName::Alt => "alt".to_string(),
            KeyName::Super => "super".to_string(),
            KeyName::Char(c) => (c as char).to_string(),
        }
    }

    pub fn modifier(self) -> Option<Modifier> {
        match self {
            KeyName::Shift => Some(Modifier::Shift),
            KeyName::Control => Some(Modifier::Control),
            KeyName::Alt => Some(Modifier::Alt),
            KeyName::Super => Some(Modifier::Super),
            _ => None,
        }
    }

    pub fn character(self, shifted: bool) -> Option<char> {
        match self {
            KeyName::Char(c) => {
                let c = c as char;
                Some(if shifted { shifted_ansi(c) } else { c })
            }
            KeyName::Space => Some(' '),
            _ => None,
        }
    }
}

pub fn shifted_ansi(c: char) -> char {
    match c {
        'a'..='z' => c.to_ascii_uppercase(),
        '1' => '!',
        '2' => '@',
        '3' => '#',
        '4' => '$',
        '5' => '%',
        '6' => '^',
        '7' => '&',
        '8' => '*',
        '9' => '(',
        '0' => ')',
        '-' => '_',
        '=' => '+',
        '[' => '{',
        ']' => '}',
        '\\' => '|',
        ';' => ':',
        '\'' => '"',
        ',' => '<',
        '.' => '>',
        '/' => '?',
        '`' => '~',
        other => other,
    }
}
