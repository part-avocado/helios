//go:build unix

package main

import (
	"os/exec"
	"syscall"
)

// detach makes cmd, which a hook starts and doesn't wait for, run in a
// session of its own, so it finishes even when the harness kills the hook's
// process group, as some do when a hook runs long or the session closes.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
