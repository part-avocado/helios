//go:build e2e && !unix

package main

import "os/exec"

// Without process groups, the harness's hook runs as is.
func ownGroup(cmd *exec.Cmd)  {}
func killGroup(cmd *exec.Cmd) {}
