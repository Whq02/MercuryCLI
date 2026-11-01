use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{channel, Sender};
use std::thread;

type Job = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone)]
pub struct Worker {
    jobs: Sender<Job>,
}

impl Worker {
    pub fn start(name: &str, init: impl FnOnce() -> Result<(), String> + Send + 'static) -> Result<Worker, String> {
        let (jobs, inbox) = channel::<Job>();
        let (ready, started) = channel::<Result<(), String>>();
        thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                if let Err(reason) = init() {
                    let _ = ready.send(Err(reason));
                    return;
                }
                let _ = ready.send(Ok(()));
                while let Ok(job) = inbox.recv() {
                    job();
                }
            })
            .map_err(|e| format!("the {name} thread could not start: {e}"))?;
        started.recv().map_err(|_| format!("the {name} thread stopped before it was ready"))??;
        Ok(Worker { jobs })
    }

    pub fn run<T: Send + 'static>(&self, job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (reply, answer) = channel::<thread::Result<Result<T, String>>>();
        let boxed: Job = Box::new(move || {
            let outcome = catch_unwind(AssertUnwindSafe(job));
            let _ = reply.send(outcome);
        });
        self.jobs.send(boxed).map_err(|_| "the worker thread is gone".to_string())?;
        answer.recv().map_err(|_| "the worker thread stopped before it answered".to_string())?.map_err(panic_text)?
    }
}

fn panic_text(payload: Box<dyn Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() { return format!("the worker job panicked: {text}"); }
    if let Some(text) = payload.downcast_ref::<String>() { return format!("the worker job panicked: {text}"); }
    "the worker job panicked".to_string()
}

#[cfg(test)]
mod tests {
    use super::Worker;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, ThreadId};
    use std::time::Duration;

    #[test]
    fn init_runs_once_on_the_worker_thread_before_any_job_and_every_job_runs_there() {
        let inits = Arc::new(AtomicUsize::new(0));
        let init_thread: Arc<Mutex<Option<ThreadId>>> = Arc::new(Mutex::new(None));
        let worker = {
            let inits = inits.clone();
            let init_thread = init_thread.clone();
            Worker::start("test-apartment", move || {
                inits.fetch_add(1, Ordering::SeqCst);
                *init_thread.lock().unwrap() = Some(thread::current().id());
                Ok(())
            })
            .unwrap()
        };
        assert_eq!(inits.load(Ordering::SeqCst), 1);
        let owner = init_thread.lock().unwrap().expect("init ran");
        assert_ne!(owner, thread::current().id());
        let seen: Vec<ThreadId> = (0..5).map(|_| worker.run(|| Ok(thread::current().id())).unwrap()).collect();
        assert!(seen.iter().all(|id| *id == owner));
        let from_elsewhere = {
            let worker = worker.clone();
            thread::spawn(move || worker.run(|| Ok(thread::current().id())).unwrap()).join().unwrap()
        };
        assert_eq!(from_elsewhere, owner);
        assert_eq!(inits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_init_is_reported_and_no_worker_is_handed_out() {
        let result = Worker::start("test-apartment", || Err("RO_INIT refused".to_string()));
        assert_eq!(result.err().as_deref(), Some("RO_INIT refused"));
    }

    #[test]
    fn a_job_error_and_a_job_panic_come_back_as_errors_and_the_thread_survives_them() {
        let worker = Worker::start("test-apartment", || Ok(())).unwrap();
        let owner = worker.run(|| Ok(thread::current().id())).unwrap();
        let failed: Result<String, String> = worker.run(|| Err("no text".to_string()));
        assert_eq!(failed, Err("no text".to_string()));
        let panicked: Result<String, String> = worker.run(|| panic!("decoder exploded"));
        assert_eq!(panicked, Err("the worker job panicked: decoder exploded".to_string()));
        assert_eq!(worker.run(|| Ok(thread::current().id())).unwrap(), owner);
    }

    struct Guard {
        log: Arc<Mutex<Vec<(&'static str, ThreadId)>>>,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            self.log.lock().unwrap().push(("captures dropped", thread::current().id()));
        }
    }

    #[test]
    fn a_job_s_captures_are_dropped_on_the_worker_thread_before_the_answer_crosses_back() {
        let worker = Worker::start("test-apartment", || Ok(())).unwrap();
        let owner = worker.run(|| Ok(thread::current().id())).unwrap();
        let log: Arc<Mutex<Vec<(&'static str, ThreadId)>>> = Arc::new(Mutex::new(Vec::new()));
        let guard = Guard { log: log.clone() };
        let text = worker.run(move || {
            let _held = &guard;
            Ok("text".to_string())
        });
        log.lock().unwrap().push(("answer received", thread::current().id()));
        assert_eq!(text, Ok("text".to_string()));
        let entries = log.lock().unwrap().clone();
        assert_eq!(entries, vec![("captures dropped", owner), ("answer received", thread::current().id())]);
    }

    #[test]
    fn jobs_from_many_threads_run_one_at_a_time_and_all_answer() {
        let worker = Worker::start("test-apartment", || Ok(())).unwrap();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let overlap = Arc::new(AtomicUsize::new(0));
        let callers: Vec<_> = (0..8)
            .map(|n| {
                let worker = worker.clone();
                let in_flight = in_flight.clone();
                let overlap = overlap.clone();
                thread::spawn(move || {
                    worker.run(move || {
                        if in_flight.fetch_add(1, Ordering::SeqCst) != 0 { overlap.fetch_add(1, Ordering::SeqCst); }
                        thread::sleep(Duration::from_millis(5));
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                        Ok(n)
                    })
                })
            })
            .collect();
        let mut answers: Vec<usize> = callers.into_iter().map(|c| c.join().unwrap().unwrap()).collect();
        answers.sort_unstable();
        assert_eq!(answers, (0..8).collect::<Vec<_>>());
        assert_eq!(overlap.load(Ordering::SeqCst), 0);
    }
}
