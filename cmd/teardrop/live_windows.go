package main

import (
	"os"
	"syscall"
)

// enableANSI turns on escape-sequence handling in the Windows console, which
// older consoles leave off. It reports whether the console now supports it.
func enableANSI() bool {
	const enableVirtualTerminalProcessing = 0x0004
	h := syscall.Handle(os.Stdout.Fd())
	var mode uint32
	if syscall.GetConsoleMode(h, &mode) != nil {
		return false
	}
	if mode&enableVirtualTerminalProcessing != 0 {
		return true
	}
	setConsoleMode := syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleMode")
	ok, _, _ := setConsoleMode.Call(uintptr(h), uintptr(mode|enableVirtualTerminalProcessing))
	return ok != 0
}
