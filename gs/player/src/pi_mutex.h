#ifndef MABUR_PLAYER_PI_MUTEX_H_
#define MABUR_PLAYER_PI_MUTEX_H_

#include <pthread.h>

namespace maburplay {

// A mutex for the release thread's data path: BasicLockable/Lockable
// (lock/unlock/try_lock), so it drops into std::lock_guard and
// std::unique_lock exactly where a std::mutex did. Every holder of these
// locks runs for microseconds, but a normal-priority holder (decode pump,
// housekeeping) that CFS preempts mid-section would otherwise make the
// SCHED_FIFO release thread wait out a whole scheduler slice --
// PTHREAD_PRIO_INHERIT has the kernel raise that holder to the waiter's
// priority for the duration, so it runs to completion and releases
// promptly instead of sitting preempted.
//
// If the platform refuses the protocol attribute (missing
// _POSIX_THREAD_PRIO_INHERIT, or a kernel built without it), falls back to
// a plain mutex rather than aborting: priority inheritance only trims the
// RT thread's worst-case wait, it is never required for correctness.
class PiMutex {
 public:
  PiMutex() {
    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    pi_ = pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT) == 0;
    pthread_mutex_init(&m_, &attr);
    pthread_mutexattr_destroy(&attr);
  }
  ~PiMutex() { pthread_mutex_destroy(&m_); }
  PiMutex(const PiMutex&) = delete;
  PiMutex& operator=(const PiMutex&) = delete;

  void lock() { pthread_mutex_lock(&m_); }
  void unlock() { pthread_mutex_unlock(&m_); }
  bool try_lock() { return pthread_mutex_trylock(&m_) == 0; }

  // True when this instance's mutex actually got PTHREAD_PRIO_INHERIT (the
  // attribute was accepted at construction). For tests: it does not affect
  // lock/unlock/try_lock behaviour, only whether priority inheritance is
  // active underneath it.
  bool pi_active() const { return pi_; }

  // True when the platform accepts PTHREAD_PRIO_INHERIT at all, checked on
  // a throwaway attribute rather than any particular instance.
  static bool pi_supported() {
    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    const bool ok = pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT) == 0;
    pthread_mutexattr_destroy(&attr);
    return ok;
  }

 private:
  pthread_mutex_t m_;
  bool pi_ = false;
};

}  // namespace maburplay

#endif  // MABUR_PLAYER_PI_MUTEX_H_
