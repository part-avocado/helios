#!/bin/sh
# Builds the release binaries that install.sh and install.ps1 download.
#
#   scripts/build-release.sh <out-dir> [version]
set -eu
out="${1:?usage: build-release.sh <out-dir> [version]}"
version="${2:-dev}"
mkdir -p "$out"
for target in linux/amd64 linux/arm64 linux/386 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64 windows/386; do
	os="${target%/*}"
	arch="${target#*/}"
	ext=""
	[ "$os" = windows ] && ext=".exe"
	CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
		-ldflags "-s -w -X main.version=$version" \
		-o "$out/helios_${os}_${arch}${ext}" ./cmd/helios
done
(cd "$out" && sha256sum helios_* >checksums.txt)
