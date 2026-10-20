package core

import (
	"math"
	"strconv"
	"strings"
)

// These names are getters in the pinned interpreter, not user variables. Keep
// the list explicit: an arbitrary choice_is_* spelling is not a proven boolean.
var booleanBuiltins = map[string]bool{
	"choice_subscribe_allowed": true, "choice_register_allowed": true, "choice_registered": true,
	"choice_is_web": true, "choice_is_steam": true, "choice_is_steam_deck": true, "choice_is_ios_app": true,
	"choice_is_ipad_app": true, "choice_is_android_app": true, "choice_is_omnibus_app": true,
	"choice_is_amazon_app": true, "choice_is_advertising_supported": true, "choice_is_trial": true,
	"choice_prerelease": true, "choice_kindle": true, "choice_randomtest": true, "choice_quicktest": true,
	"choice_restore_purchases_allowed": true, "choice_save_allowed": true, "choice_nightmode": true,
}

func builtinType(name string) Value {
	if !strings.HasPrefix(name, "choice_") {
		return 0
	}
	if booleanBuiltins[name] || strings.HasPrefix(name, "choice_saved_checkpoint") {
		return BoolType
	}
	if name == "choice_linenum" || name == "choice_time_stamp" {
		return NumberType
	}
	return 0
}
func (p *valuePool) lookupConstant(name string) Value {
	if name == "true" {
		return p.boolean(true)
	}
	if name == "false" {
		return p.boolean(false)
	}
	n, err := strconv.ParseFloat(name, 64)
	if err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && (primitive{Kind: uint8(NumberType), Number: n}).string() == name {
		return p.number(n)
	}
	return 0
}
