//go:build !unix && !windows

package main

import "os/exec"

// detach does nothing on systems without sessions or consoles.
func detach(cmd *exec.Cmd) {}
