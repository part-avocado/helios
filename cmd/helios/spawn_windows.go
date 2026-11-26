package main

import (
	"os/exec"
	"syscall"
)

// detach makes cmd, which a hook starts and doesn't wait for, run without
// a console. A hook run by an editor has no console of its own, so Windows
// would otherwise open a console window for helios and flash it. Its own
// process group keeps a Ctrl+C in the terminal that ran the hook from
// stopping it.
func detach(cmd *exec.Cmd) {
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow | syscall.CREATE_NEW_PROCESS_GROUP,
	}
}
