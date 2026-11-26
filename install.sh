#!/bin/sh
# Install teardrop on macOS, Linux, or Git Bash on Windows:
#
#   curl -fsSL https://raw.githubusercontent.com/part-avocado/teardrop/main/install.sh | sh
#
# Settings, all optional:
#   TEARDROP_VERSION=v0.1.0       install this release instead of the latest
#   TEARDROP_INSTALL_DIR=<dir>    install here instead of ~/.local/bin
#   TEARDROP_NO_MODIFY_PATH=1     don't add the install dir to your shell profile
#   TEARDROP_NO_SETUP=1           don't run `teardrop setup` afterwards
#   TEARDROP_CLOUD=1              for a cloud environment or Codespace: set up Claude Code
#                                 and every other tool found, without asking. Also set
#                                 TEARDROP_SERVER and TEARDROP_KEY as secrets there; hooks
#                                 then send time straight to the site.
#
# Rerunning it updates teardrop in place.
set -eu

REPO="part-avocado/teardrop"

say() { printf '%s\n' "$*"; }
fail() {
	printf 'teardrop install: %s\n' "$*" >&2
	exit 1
}

# fetch downloads $1 to $2. With a third argument "progress" it shows a
# progress bar, when there is a terminal to show it on.
fetch() {
	if command -v curl >/dev/null 2>&1; then
		if [ "${3:-}" = progress ] && [ -t 2 ]; then
			curl -fL --retry 3 -# -o "$2" "$1"
		else
			curl -fsSL --retry 3 -o "$2" "$1"
		fi
	elif command -v wget >/dev/null 2>&1; then
		if [ "${3:-}" = progress ] && [ -t 2 ]; then
			# Older wget has no --show-progress; fall back to a quiet download.
			wget -q --show-progress -O "$2" "$1" || wget -q -O "$2" "$1"
		else
			wget -q -O "$2" "$1"
		fi
	else
		fail "curl or wget is needed to download teardrop"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v openssl >/dev/null 2>&1; then
		# Prints "SHA2-256(file)= <hex>", or "SHA256(file)= <hex>" when older.
		openssl dgst -sha256 "$1" | awk '{ print $NF }'
	fi
}

# The whole script runs from main, so a download cut off midway runs nothing.
main() {
	version="${TEARDROP_VERSION:-latest}"
	base="${TEARDROP_BASE_URL:-}"
	if [ -z "$base" ]; then
		if [ "$version" = latest ]; then
			base="https://github.com/$REPO/releases/latest/download"
		else
			base="https://github.com/$REPO/releases/download/$version"
		fi
	fi
	bin_dir="${TEARDROP_INSTALL_DIR:-$HOME/.local/bin}"

	os=$(uname -s)
	case "$os" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	MINGW* | MSYS* | CYGWIN*) os=windows ;;
	*) fail "$os is not supported. Supported: macOS, Linux, Windows." ;;
	esac
	arch=$(uname -m)
	case "$arch" in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	i386 | i486 | i586 | i686) arch=386 ;;
	*) fail "$arch processors are not supported" ;;
	esac
	# A shell running under Rosetta reports x86_64 on Apple Silicon.
	if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
		arch=arm64
	fi
	ext=""
	[ "$os" = windows ] && ext=".exe"
	asset="teardrop_${os}_${arch}${ext}"

	tmp=$(mktemp -d 2>/dev/null || mktemp -d -t teardrop)
	trap 'rm -rf "$tmp"' EXIT INT TERM

	say "Downloading teardrop ($os/$arch)..."
	fetch "$base/$asset" "$tmp/$asset" progress || fail "could not download $base/$asset"
	fetch "$base/checksums.txt" "$tmp/checksums.txt" || fail "could not download $base/checksums.txt"

	want=$(awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n) } n == a { print $1 }' "$tmp/checksums.txt")
	[ -n "$want" ] || fail "checksums.txt has no entry for $asset"
	got=$(sha256 "$tmp/$asset")
	if [ -z "$got" ]; then
		fail "sha256sum, shasum, or openssl is needed to verify the download. Nothing was installed."
	elif [ "$got" != "$want" ]; then
		fail "the download is corrupted (checksum mismatch). Nothing was installed; try again."
	fi

	mkdir -p "$bin_dir" || fail "could not create $bin_dir"
	target="$bin_dir/teardrop$ext"
	chmod +x "$tmp/$asset"
	# Copy next to the target, then rename, so a running teardrop is never half-written.
	cp "$tmp/$asset" "$target.new" && mv -f "$target.new" "$target" || fail "could not write $target"
	say "Installed $("$target" -version 2>/dev/null || echo teardrop) to $target"

	case ":$PATH:" in
	*":$bin_dir:"*) on_path=1 ;;
	*) on_path=0 ;;
	esac
	added=0
	if [ "$on_path" = 0 ]; then
		add_to_path "$bin_dir"
	fi

	if [ -z "${TEARDROP_NO_SETUP:-}" ]; then
		say ""
		# When piped from curl, stdin is this script, so setup asks on the terminal instead.
		case "$(printf '%s' "${TEARDROP_CLOUD:-}" | tr '[:upper:]' '[:lower:]')" in 1 | true) cloud=1 ;; *) cloud= ;; esac
		if [ -n "$cloud" ]; then
			if [ -z "${TEARDROP_SERVER:-}" ] || [ -z "${TEARDROP_KEY:-}" ]; then
				say "Warning: TEARDROP_CLOUD is set, but TEARDROP_SERVER and TEARDROP_KEY are not both set."
				say "Add them as secrets of this environment, or its hooks will send nothing to your site."
				say ""
			fi
			# Naming claude makes its folder on a fresh container; the second run
			# sets up every other tool found, such as Codex, Copilot, or Cursor.
			"$target" setup -yes claude </dev/null || true
			"$target" setup -yes </dev/null || true
		elif (exec </dev/tty) 2>/dev/null; then
			"$target" setup </dev/tty || true
		else
			# No terminal to ask on: setup lists what it found and changes nothing.
			"$target" setup </dev/null || true
		fi
	fi
	if [ "$added" = 1 ]; then
		say ""
		say "Open a new terminal, then run: teardrop"
	fi
}

# add_to_path adds dir to PATH in the profile of the user's shell.
add_to_path() {
	line="export PATH=\"$1:\$PATH\""
	case "${SHELL:-}" in
	*/zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
	*/bash)
		profile="$HOME/.bashrc"
		# macOS terminals start login shells, which read .bash_profile.
		[ "$(uname -s)" = Darwin ] && profile="$HOME/.bash_profile"
		;;
	*/fish)
		profile="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/teardrop.fish"
		line="fish_add_path \"$1\""
		;;
	*) profile="$HOME/.profile" ;;
	esac
	if [ -n "${TEARDROP_NO_MODIFY_PATH:-}" ]; then
		say "$1 is not on your PATH. Add this line to $profile:"
		say "  $line"
		return
	fi
	if [ -f "$profile" ] && grep -qF "$line" "$profile"; then
		added=1 # added by an earlier run; this terminal may still predate it
		return
	fi
	mkdir -p "$(dirname "$profile")"
	printf '\n# Added by the teardrop installer\n%s\n' "$line" >>"$profile" ||
		{
			say "Could not edit $profile. Add this line to it: $line"
			return
		}
	added=1
	say "Added $1 to your PATH in $profile"
}

main "$@"
