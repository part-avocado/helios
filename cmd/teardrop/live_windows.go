package main

import (
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32                   = syscall.NewLazyDLL("kernel32.dll")
	setConsoleMode             = kernel32.NewProc("SetConsoleMode")
	getConsoleScreenBufferInfo = kernel32.NewProc("GetConsoleScreenBufferInfo")
)

// console reports whether f is a console that handles escape sequences,
// turning that on in older consoles that leave it off, and its size in
// characters (0 when Windows won't say).
func console(f *os.File) (cols, rows int, ok bool) {
	const enableVirtualTerminalProcessing = 0x0004
	h := syscall.Handle(f.Fd())
	var mode uint32
	if syscall.GetConsoleMode(h, &mode) != nil {
		return 0, 0, false // a file or a pipe
	}
	if mode&enableVirtualTerminalProcessing == 0 {
		if set, _, _ := setConsoleMode.Call(uintptr(h), uintptr(mode|enableVirtualTerminalProcessing)); set == 0 {
			return 0, 0, false
		}
	}
	// CONSOLE_SCREEN_BUFFER_INFO; the window is the visible part of the buffer.
	var info struct {
		Size, Cursor struct{ X, Y int16 }
		Attributes   uint16
		Window       struct{ Left, Top, Right, Bottom int16 }
		MaxWindow    struct{ X, Y int16 }
	}
	if got, _, _ := getConsoleScreenBufferInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&info))); got != 0 {
		cols, rows = int(info.Window.Right-info.Window.Left)+1, int(info.Window.Bottom-info.Window.Top)+1
	}
	return cols, rows, true
}
