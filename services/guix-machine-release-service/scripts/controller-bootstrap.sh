# Controller bootstrap (projected from guix-machine-release-service scripts/controller-bootstrap.sh).
printf '%s\n' 'Unprojected controller bootstrap refused; use the owning projector.' >&2; exit 1
# Resolve the release controller from the machine repository's own gitlink and fetch exactly the commit it records.
# The projected trusted source gate must verify the reused checkout before it can be published.
unset RELEASE_CONTROLLER service
git_reader="$(command -v git)"; [[ "$git_reader" = /* ]] && [ -x "$git_reader" ]
controller_repository=red-cup-engineering/guix-machine-release-service
controller_top="$(git rev-parse --show-toplevel)"
controller_names="$(git -C "$controller_top" config -f .gitmodules --get-regexp "^submodule\\..*\\.url$" | awk -v a="https://github.com/$controller_repository.git" -v b="https://github.com/$controller_repository" "\$2==a || \$2==b {sub(/^submodule\\./, \"\", \$1); sub(/\\.url$/, \"\", \$1); print \$1}")"
[ "$(printf "%s" "$controller_names" | grep -c .)" = 1 ] || { echo "the machine repository must mount the release controller exactly once" >&2; exit 1; }
controller_mount="$(git -C "$controller_top" config -f .gitmodules --get "submodule.$controller_names.path")"
controller_commit="$(git -C "$controller_top" ls-tree HEAD -- "$controller_mount" | awk "\$2==\"commit\" {print \$3}")"
[[ "$controller_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "release controller needs an exact commit" >&2; exit 1; }
controller_path=.
configure_release_source_reader
controller_root="$HOME/.cache/561-group/github-source-bootstrap/$GITHUB_REPOSITORY/$GITHUB_SHA/controller"
verify_controller_checkout() {
controller_tree="$(env -i PATH="$(dirname "$git_reader"):/usr/bin:/bin" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= "$git_reader" -C "$controller_root" rev-parse "$controller_commit^{tree}")"
[[ "$controller_tree" =~ ^[0-9a-f]{40}$ ]] || { echo 'release controller needs an exact tree' >&2; exit 1; }
verify_release_source "$controller_root" "$controller_repository" "$controller_commit" "$controller_tree" '' controller controller-admission-v1 ''
}
mkdir -p "$(dirname "$controller_root")"
if [ -d "$controller_root/.git" ]; then
  # Exact verified reuse needs no refresh or checkout; cached filters never run.
  verify_controller_checkout || exit $?
else
  "${source_git[@]}" clone -q --filter=blob:none --no-checkout "https://github.com/$controller_repository.git" "$controller_root"
"${source_git[@]}" -C "$controller_root" fetch -q --depth=1 origin "$controller_commit" || exit $?
"${source_git[@]}" -C "$controller_root" sparse-checkout disable || exit $?
"${source_git[@]}" -C "$controller_root" checkout -q --detach "$controller_commit" || exit $?
verify_controller_checkout || exit $?
fi
service="$(realpath "$controller_root/$controller_path")"
case "$service/" in "$(realpath "$controller_root")/"*) ;; *) echo 'release controller resolves outside its repository' >&2; exit 1;; esac
echo "RELEASE_CONTROLLER=$service" >> "$GITHUB_ENV"
# End controller bootstrap.
