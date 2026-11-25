// Package site is the teardrop website. The Worker in ../worker serves it on
// Cloudflare, and it is embedded in the binary so `teardrop dashboard` can
// serve it too.
package site

import "embed"

//go:embed *.html *.css *.js *.json *.svg
var FS embed.FS
