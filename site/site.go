// Package site is the teardrop website: a static site published to GitHub
// Pages, also embedded in the binary so `teardrop dashboard` can serve it.
package site

import "embed"

//go:embed *.html *.css *.js *.svg
var FS embed.FS
