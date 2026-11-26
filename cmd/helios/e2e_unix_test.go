//go:build e2e && unix

package main

import (
	"os/exec"
	"syscall"
)

// ownGroup runs cmd in a process group of its own, as a harness runs a hook.
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killGroup kills cmd's process group, as a harness may once the hook returns.
func killGroup(cmd *exec.Cmd) { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
