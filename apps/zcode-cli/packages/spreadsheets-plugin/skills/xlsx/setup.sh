#!/usr/bin/env bash
# ---
# name: xlsx-setup
# author: Z.AI
# version: "1.0"
# description: Environment setup for the XLSX skill. Checks and installs all required dependencies.
# ---
#
# Installs only dependencies required by the XLSX skill.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}○${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

echo "============================================"
echo "  XLSX Skill — Environment Setup"
echo "============================================"
echo ""

OS="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: $OS $ARCH"
echo ""

# ── 0. macOS: Homebrew ──
if [ "$OS" = "Darwin" ]; then
    echo "--- Homebrew (macOS package manager) ---"
    if command -v brew &>/dev/null; then
        BREW_VER=$(brew --version 2>/dev/null | head -1)
        ok "brew ($BREW_VER)"
    else
        fail "brew not found — some optional dependencies need Homebrew on macOS"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    fi
    echo ""
fi

# ── 1. Python 3 ──
echo "--- Python ---"
if command -v python3 &>/dev/null; then
    PY_VER=$(python3 --version 2>&1)
    ok "python3 ($PY_VER)"
    if [ "$OS" = "Darwin" ]; then
        PY_PATH=$(which python3 2>/dev/null)
        if [[ "$PY_PATH" == "/usr/bin/python3" ]]; then
            warn "Using macOS system Python (limited). Recommend: brew install python3"
        fi
    fi
else
    fail "python3 not found"
    case "$OS" in
        Darwin) info "Install: brew install python3" ;;
        Linux)  info "Install: sudo apt install python3 python3-pip  (Debian/Ubuntu)"
                info "         sudo dnf install python3 python3-pip  (Fedora/RHEL)" ;;
        *)      info "Install: https://www.python.org/downloads/" ;;
    esac
fi

# ── 2. pip ──
echo ""
echo "--- pip ---"
if python3 -m pip --version &>/dev/null 2>&1; then
    PIP_VER=$(python3 -m pip --version 2>/dev/null | head -1)
    ok "pip ($PIP_VER)"
else
    fail "pip not found"
    case "$OS" in
        Darwin) info "Install: python3 -m ensurepip --upgrade"
                info "     or: brew install python3 (includes pip)" ;;
        Linux)  info "Install: sudo apt install python3-pip  (Debian/Ubuntu)" ;;
        *)      info "Install: python3 -m ensurepip --upgrade" ;;
    esac
fi

# ── 3. Python packages ──
echo ""
echo "--- Python Packages ---"
PY_PKGS=(
    "openpyxl:openpyxl"
    "xlsxwriter:XlsxWriter"
)

MISSING_PY=()
for entry in "${PY_PKGS[@]}"; do
    mod="${entry%%:*}"
    pkg="${entry##*:}"
    if python3 -c "import $mod" 2>/dev/null; then
        ver=$(python3 -c "import $mod; print(getattr($mod, '__version__', 'installed'))" 2>/dev/null)
        ok "$pkg ($ver)"
    else
        fail "$pkg not installed"
        MISSING_PY+=("$pkg")
    fi
done

if [ ${#MISSING_PY[@]} -gt 0 ]; then
    echo ""
    if [ -t 0 ]; then
        read -p "  Install missing Python packages? [Y/n] " -n 1 -r REPLY
        echo ""
        REPLY=${REPLY:-Y}
    else
        warn "Non-interactive mode — skipping auto-install. Run interactively or install manually."
        REPLY=N
    fi
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        python3 -m pip install -q "${MISSING_PY[@]}" 2>/dev/null \
            || python3 -m pip install -q --user "${MISSING_PY[@]}" 2>/dev/null \
            || python3 -m pip install -q --break-system-packages "${MISSING_PY[@]}" 2>/dev/null \
            || { fail "pip install failed. Try manually: pip install ${MISSING_PY[*]}"; }
        ok "Installed: ${MISSING_PY[*]}"
    fi
fi

# ── 4. Conversion engine (bundled dsoffice first, local LibreOffice second) ──
echo ""
echo "--- Conversion engine (recalc, .xlsx→PDF, .csv→.xlsx) ---"
if command -v dsoffice &>/dev/null; then
    ok "dsoffice (bundled engine)"
elif command -v soffice &>/dev/null; then
    LO_VER=$(soffice --version 2>/dev/null | head -1)
    ok "libreoffice ($LO_VER)"
else
    warn "no conversion engine (dsoffice / soffice) — needed for recalc, .xlsx→PDF, .csv→.xlsx"
    info "Follow SKILL.md 'Office conversion engine resolution order':"
    info "  1. Bundled dsoffice is preferred — if missing, this package was built with"
    info "     ZCODE_SKIP_LIBREOFFICE_KIT=1 or is a slim build."
    info "  2. Probe local LibreOffice and register off-PATH installs (never reinstall):"
    info "     ls /opt/libreoffice*/program/soffice /Applications/LibreOffice.app/Contents/MacOS/soffice"
    info "  3. With USER CONSENT and network: install (download is large, hundreds of MB)."
    info "     PREFERRED source (fast in China, current build): Tsinghua TUNA mirror"
    info "       https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/"
    info "       Pick the subdir for this platform/arch ($(uname -m)):"
    info "         Linux deb  -> deb/x86_64/ or deb/aarch64/   (tar -xzf, then dpkg -i */DEBS/*.deb)"
    info "         Linux rpm  -> rpm/x86_64/"
    info "         macOS      -> mac/aarch64/ (Apple Silicon) or mac/x86_64/ (Intel)  (.dmg)"
    info "     Package-manager FALLBACK (only if the mirror is unreachable):"
    case "$OS" in
        Darwin) info "       brew install --cask libreoffice" ;;
        Linux)  info "       sudo apt install libreoffice-core  (Debian/Ubuntu)" ;;
    esac
    info "     AFTER installing, REGISTER the binary on PATH -- the method differs per OS:"
    case "$OS" in
        Darwin) info "       sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /usr/local/bin/soffice"
                info "       (Apple Silicon: use /opt/homebrew/bin/soffice if /usr/local/bin is not on PATH)" ;;
        Linux)  info "       sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice" ;;
    esac
    info "     then re-verify: soffice --version"
    info "  4. No network? With user consent, recalculating via local Excel/WPS is acceptable;"
    info "     warn that results may differ from LibreOffice."
    info "  5. If nothing works, deliver with engine-free checks (audit/scan/validate) and report"
    info "     that formula values may be stale. Never silently skip recalculation."
fi

# ── Summary ──
echo ""
echo "============================================"
echo "  Setup complete."
echo "============================================"
