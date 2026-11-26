// Package site is the helios website. The Worker in ../worker serves it on
// Cloudflare, and it is embedded in the binary so `helios dashboard` can
// serve it too.
package site

import "embed"

//go:embed *.html *.css *.js *.json *.svg
var FS embed.FS
