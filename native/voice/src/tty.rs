
use napi_derive::napi;

#[napi(object)]
pub struct ProcessGroupAnswer {
    pub pgid: Option<i32>,
    pub reason: Option<String>,
}

#[napi(object)]
pub struct TerminalReclaimAnswer {
    pub reclaimed: bool,
    pub before: Option<i32>,
    pub after: Option<i32>,
    pub reason: Option<String>,
}

#[napi]
pub fn tty_foreground_group(fd: i32) -> ProcessGroupAnswer {
    match imp::foreground_group(fd) {
        Ok(pgid) => ProcessGroupAnswer { pgid: Some(pgid), reason: None },
        Err(reason) => ProcessGroupAnswer { pgid: None, reason: Some(reason) },
    }
}

#[napi]
pub fn own_process_group() -> ProcessGroupAnswer {
    match imp::own_group() {
        Ok(pgid) => ProcessGroupAnswer { pgid: Some(pgid), reason: None },
        Err(reason) => ProcessGroupAnswer { pgid: None, reason: Some(reason) },
    }
}

#[napi]
pub fn reclaim_terminal(fd: i32) -> TerminalReclaimAnswer {
    imp::reclaim(fd)
}

#[cfg(unix)]
mod imp {
    use super::TerminalReclaimAnswer;

    fn os_error() -> String {
        std::io::Error::last_os_error().to_string()
    }

    pub fn foreground_group(fd: i32) -> Result<i32, String> {
        let pgid = unsafe { libc::tcgetpgrp(fd) };
        if pgid < 0 {
            Err(os_error())
        } else {
            Ok(pgid as i32)
        }
    }

    pub fn own_group() -> Result<i32, String> {
        Ok(unsafe { libc::getpgrp() } as i32)
    }

    pub fn reclaim(fd: i32) -> TerminalReclaimAnswer {
        let own = match own_group() {
            Ok(pgid) => pgid,
            Err(reason) => {
                return TerminalReclaimAnswer { reclaimed: false, before: None, after: None, reason: Some(reason) }
            }
        };
        let before = match foreground_group(fd) {
            Ok(pgid) => pgid,
            Err(reason) => {
                return TerminalReclaimAnswer { reclaimed: false, before: None, after: None, reason: Some(reason) }
            }
        };
        let mut ignore: libc::sigaction = unsafe { std::mem::zeroed() };
        ignore.sa_sigaction = libc::SIG_IGN;
        let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
        let shielded = unsafe {
            libc::sigemptyset(&mut ignore.sa_mask) == 0
                && libc::sigaction(libc::SIGTTOU, &ignore, &mut previous) == 0
        };
        if !shielded {
            return TerminalReclaimAnswer { reclaimed: false, before: Some(before), after: None, reason: Some(os_error()) };
        }
        let set = unsafe { libc::tcsetpgrp(fd, own as libc::pid_t) };
        let reason = if set == 0 { None } else { Some(os_error()) };
        unsafe { libc::sigaction(libc::SIGTTOU, &previous, std::ptr::null_mut()) };
        let after = foreground_group(fd).ok();
        TerminalReclaimAnswer {
            reclaimed: set == 0 && before != own && after == Some(own),
            before: Some(before),
            after,
            reason,
        }
    }
}

#[cfg(not(unix))]
mod imp {
    use super::TerminalReclaimAnswer;

    const UNSUPPORTED: &str = "unsupported";

    pub fn foreground_group(_fd: i32) -> Result<i32, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn own_group() -> Result<i32, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn reclaim(_fd: i32) -> TerminalReclaimAnswer {
        TerminalReclaimAnswer { reclaimed: false, before: None, after: None, reason: Some(UNSUPPORTED.to_string()) }
    }
}
