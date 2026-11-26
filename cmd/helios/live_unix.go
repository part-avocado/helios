//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// console reports whether f is a terminal, and its size in characters.
func console(f *os.File) (cols, rows int, ok bool) {
	var size struct{ Rows, Cols, X, Y uint16 }
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(syscall.TIOCGWINSZ), uintptr(unsafe.Pointer(&size)))
	if errno != 0 {
		return 0, 0, false // a file, a pipe, or /dev/null
	}
	return int(size.Cols), int(size.Rows), true
}
