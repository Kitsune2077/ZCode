#!/usr/bin/env bash
# Lightweight environment check for DOCX skill.
# Exit 0 = all OK, exit 1 = missing dependencies.
# Also resolves and exports DOCX_SKILL_DIR and FONT_DIR.
# Usage: source env_check.sh  (preferred, exports vars to caller)
#    or: bash env_check.sh [--quiet]
QUIET=false; [ "${1:-}" = "--quiet" ] && QUIET=true
FAIL=0
check() { local desc="$1"; shift; if ! "$@" &>/dev/null; then $QUIET || echo "MISSING: $desc"; FAIL=1; fi; }
# Office 转换引擎：随包 dsoffice 优先，其次本机已有的 LibreOffice。两者都缺不算本检查失败——
# 后续动作按 SKILL.md "Office conversion engine resolution order" 降级链处理（征得用户同意安装、
# 经同意用本机 Word/WPS 并警告保真度、或如实报告不可用），唯独不允许静默跳过验证。
report_engine() {
    if command -v dsoffice &>/dev/null; then
        $QUIET || echo "engine OK: dsoffice (bundled)"
    elif command -v soffice &>/dev/null; then
        $QUIET || echo "engine OK: soffice (local LibreOffice)"
    else
        $QUIET || echo "engine MISSING: no dsoffice / soffice — follow SKILL.md 'Office conversion engine resolution order': bundled dsoffice → probe local soffice (register off-PATH installs, never reinstall) → user-consented install (Tsinghua mirror / winget / brew / apt) → user-consented local Word/WPS with fidelity warning → deliver with text-level checks and report which operations are unavailable. Do NOT silently skip verification."
    fi
}

# ── Resolve DOCX_SKILL_DIR & FONT_DIR ──
_ENV_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DOCX_SKILL_DIR="$(cd "$_ENV_CHECK_DIR/.." && pwd)"
export DOCX_SKILL_DIR

if [ "$(uname -s)" = "Darwin" ]; then
    FONT_DIR="${HOME}/Library/Fonts"
else
    FONT_DIR="/usr/share/fonts"
fi
export FONT_DIR

check "node"        command -v node
check "python3"     command -v python3
check "defusedxml"  python3 -c "import defusedxml"

# Font check
if command -v fc-list &>/dev/null; then
    fc-list :lang=zh 2>/dev/null | grep -qi "noto\|simhei\|wenquanyi" || { $QUIET || echo "MISSING: CJK fonts"; FAIL=1; }
fi

# ── Conversion engine probe: bundled dsoffice first, then local soffice ──
report_engine

$QUIET || echo "DOCX_SKILL_DIR=$DOCX_SKILL_DIR"
$QUIET || echo "FONT_DIR=$FONT_DIR"
return $FAIL 2>/dev/null || exit $FAIL
