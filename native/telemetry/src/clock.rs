//! Monotonic timing.
//!
//! Every rate in this crate is divided by an interval measured here. Wall-clock
//! time is recorded separately, for display and persistence only: it can jump
//! backwards (NTP, manual change, DST) and must never reach a rate calculation.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// A monotonic reference point established when the collector starts.
#[derive(Debug, Clone, Copy)]
pub struct MonotonicClock {
    origin: Instant,
}

impl MonotonicClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }

    /// Milliseconds elapsed since the clock was created. Never decreases.
    ///
    /// `Instant` on Windows is backed by `QueryPerformanceCounter`, and the
    /// standard library guarantees monotonicity.
    pub fn elapsed_ms(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1000.0
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

/// Wall-clock milliseconds since the Unix epoch. Display/persistence only.
pub fn wall_clock_unix_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Number of 100ns intervals between 1601-01-01 (FILETIME epoch) and
/// 1970-01-01 (Unix epoch).
pub const FILETIME_UNIX_EPOCH_DELTA_100NS: i64 = 116_444_736_000_000_000;

/// Convert a FILETIME expressed in 100ns units to Unix epoch milliseconds.
pub fn filetime_100ns_to_unix_ms(filetime_100ns: i64) -> f64 {
    (filetime_100ns - FILETIME_UNIX_EPOCH_DELTA_100NS) as f64 / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotonic_clock_does_not_decrease() {
        let clock = MonotonicClock::new();
        let a = clock.elapsed_ms();
        let b = clock.elapsed_ms();
        assert!(b >= a);
        assert!(a >= 0.0);
    }

    #[test]
    fn filetime_epoch_conversion_matches_known_value() {
        // 1970-01-01T00:00:00Z expressed as FILETIME is exactly the delta.
        assert_eq!(
            filetime_100ns_to_unix_ms(FILETIME_UNIX_EPOCH_DELTA_100NS),
            0.0
        );
        // 2000-01-01T00:00:00Z = 946684800000 ms since epoch.
        let ft = FILETIME_UNIX_EPOCH_DELTA_100NS + 946_684_800_000 * 10_000;
        assert_eq!(filetime_100ns_to_unix_ms(ft), 946_684_800_000.0);
    }
}
