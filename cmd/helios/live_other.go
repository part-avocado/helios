//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly || windows)

package main

import "os"

// console reports that f is not a terminal: on these systems live mode
// prints plain frames.
func console(f *os.File) (cols, rows int, ok bool) { return 0, 0, false }
