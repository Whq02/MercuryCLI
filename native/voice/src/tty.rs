//! The terminal hand-back — the controlling terminal's foreground process
//! group, read and reclaimed.
//!
//! Mercury hands the real terminal to a deliberate child (an external
//! editor, the terminal panel's shell). A job-control child takes the
//! terminal's foreground process group for itself and gives it back on a
//! normal exit; when it is killed nothing gives it back, and the parent's
//! next read of the terminal stops its whole process group (SIGTTIN). Node
//! has no tcsetpgrp, so the reclaim is this one native call.
//!
//! Surface (camelCase on the JS side):
//!   ttyForegroundGroup(fd)   tcgetpgrp(fd)            → { pgid, reason }
//!   ownProcessGroup()        getpgrp()                → { pgid, reason }
//!   reclaimTerminal(fd)      tcsetpgrp(fd, getpgrp()) with SIGTTOU ignored
//!                            for the call and the previous disposition put
//!                            back after → { reclaimed, before, after, reason }
//!
//! POSIX only: off it every function exists and answers reason
//! "unsupported" (there is no job control to reclaim from).

use napi_derive::napi;

/// A process group id, or the reason none could be answered.
#[napi(object)]
pub struct ProcessGroupAnswer {
    pub pgid: Option<i32>,
    /// "unsupported" off POSIX; else the operating system's error text.
    pub reason: Option<String>,
}

/// The outcome of a reclaim: the foreground group before and after the call.
#[napi(object)]
pub struct TerminalReclaimAnswer {
    /// The call set the foreground group to ours, and it had not been ours.
    pub reclaimed: bool,
    pub before: Option<i32>,
    pub after: Option<i32>,
    /// "unsupported" off POSIX; else why the call failed (null when it did not).
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
        // SAFETY: tcgetpgrp only reads; a descriptor that is not a terminal
        // answers -1 with errno set.
        let pgid = unsafe { libc::tcgetpgrp(fd) };
        if pgid < 0 {
            Err(os_error())
        } else {
            Ok(pgid as i32)
        }
    }

    pub fn own_group() -> Result<i32, String> {
        // SAFETY: getpgrp has no failure mode.
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
        // A background process group's tcsetpgrp draws SIGTTOU — the very
        // stop this call exists to prevent — unless the signal is ignored:
        // ignore it for the call, then put the previous disposition back
        // exactly as it was (the host may hold its own handler).
        // SAFETY: both structs are zero-initialised then filled by the calls
        // below; sigaction copies them and never retains the pointers.
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
        // SAFETY: fd is the caller's terminal descriptor; own is a process
        // group of this session (our own).
        let set = unsafe { libc::tcsetpgrp(fd, own as libc::pid_t) };
        let reason = if set == 0 { None } else { Some(os_error()) };
        // SAFETY: `previous` is the disposition sigaction wrote above.
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
