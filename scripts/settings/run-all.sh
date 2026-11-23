#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/boot/**
# gate-watch: src/commands/**
# gate-watch: src/crew/**
# gate-watch: src/daemon/**
# gate-watch: src/engine/**
# gate-watch: src/integrations/**
# gate-watch: src/models/**
# gate-watch: src/permissions/rules/* src/platform/async/*
# gate-watch: src/platform/editor/*
# gate-watch: scripts/ui/gridToPng.ts
# gate-watch: src/platform/environment/* src/platform/errors/* src/platform/files/* src/platform/git/** src/platform/health/**
# gate-watch: src/platform/host-os/*
# gate-watch: src/platform/images/* src/platform/logs/*
# gate-watch: src/platform/network/*
# gate-watch: src/platform/observability/*
# gate-watch: src/platform/primitives/* src/platform/processes/*
# gate-watch: src/platform/product/* src/platform/secrets/* src/platform/settings/** src/platform/shell/* src/platform/storage/* src/platform/text/* src/screen/** src/sessions/**
# gate-watch: src/tools/crewmate/**
# gate-watch: src/tools/edit/** src/tools/glob/*
# gate-watch: scripts/ui/fixtures/settings-popup-header/*
# gate-watch: src/tools/kit/*
# gate-watch: src/tools/read/**
# gate-watch: src/tools/sleep/*
# gate-watch: src/tools/web-fetch/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/settings"
fail=0
echo "############################################################"
echo "# settings — configuration pipeline proof harness"
echo "############################################################"
export TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
drive_members settings 'scripts/settings/$name' "$here/members.txt" || fail=1
exit $fail
