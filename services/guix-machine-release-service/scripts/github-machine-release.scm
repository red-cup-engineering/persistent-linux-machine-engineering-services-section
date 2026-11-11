;;; GitHub owns invocation; this program builds only the snapshot's exact inputs.
(use-modules (ice-9 match) (ice-9 popen) (ice-9 rdelim) (ice-9 format)
             (ice-9 ftw) (json) (srfi srfi-1) (srfi srfi-43))
(umask #o077)
(load (string-append (dirname (car (command-line))) "/../src/controller-owner.scm"))
(define (run . argv)
  (unless (zero? (apply system* argv)) (error "release step failed" (car argv))))
(define (capture . argv)
  (let* ((p (apply open-pipe* OPEN_READ argv))
         (lines (let loop ((out '())) (let ((line (read-line p)))
                   (if (eof-object? line) (reverse out) (loop (cons line out))))))
         (status (close-pipe p)))
    (unless (zero? status)
      ;; Assembly returns its closure as the last stdout line. Preserve bounded
      ;; compiler/test diagnostics when it fails, instead of discarding them.
      (for-each (lambda (line) (display line (current-error-port)) (newline (current-error-port)))
                (drop lines (max 0 (- (length lines) 40))))
      (error "release step failed" (car argv)))
    (if (null? lines) "" (last lines))))
(define (capture-all . argv)
  (let* ((p (apply open-pipe* OPEN_READ argv))
         (lines (let loop ((out '())) (let ((line (read-line p)))
                   (if (eof-object? line) (reverse out) (loop (cons line out))))))
         (status (close-pipe p)))
    (unless (zero? status) (error "release step failed" (car argv)))
    (string-join lines "\n")))
(define (read-json path) (call-with-input-file path json->scm))
(define (write-json path value)
  (call-with-output-file path (lambda (p) (scm->json value p) (newline p))))
(define (shell-word text)
  (unless (and (string? text) (> (string-length text) 0)
               (every (lambda (c) (or (char-alphabetic? c) (char-numeric? c)
                                      (memv c '(#\/ #\. #\_ #\- #\: #\=))))
                      (string->list text)))
    (error "invalid remote release argument"))
  text)
(define (remote host . arguments)
  (apply run "ssh" "--" (shell-word host)
         (list (string-join
           (append (list "env")
             (filter-map (lambda (name) (and (getenv name) (shell-word (string-append name "=" (getenv name)))))
                         '("GITHUB_REPOSITORY" "GITHUB_RUN_ID" "GITHUB_RUN_ATTEMPT" "GITHUB_SHA" "GITHUB_REF"))
             (map shell-word arguments)) " "))))
(define (remote-receive config controller store options)
  (apply remote (assoc-ref config "receiverHost") "guix" "repl" "--"
         (string-append controller "/scripts/pinned-guix.scm")
         (string-append controller "/channels.scm")
         "shell" "guile" "guile-json" "--" "guile" "--no-auto-compile"
         (string-append controller "/scripts/receive.scm")
         (string-append controller "/machine.json") store options))
;; Preserve the media receiver's own failure. Its fixed read-only dependency
;; projection is diagnostic context, not an activation or receiving assertion.
;; The media script may already have attempted rollback before throwing here.
(define (receive-media config store mode)
  (let ((program (string-append store "/node_modules/@causeway-services/public-education-services-section/scripts/receive-production.mjs"))
        (diagnostic (string-append store "/.controller/scripts/media-dependency-observation.mjs"))
        (node (string-append store "/bin/node")))
    (catch #t
      (lambda ()
        (if (assoc-ref config "receiverHost")
          (remote (assoc-ref config "receiverHost") "env"
                  (string-append "GITHUB_SHA=" (or (getenv "GITHUB_SHA") ""))
                  node program store (if (equal? mode "deploy") "receive" "check"))
          (run node program store (if (equal? mode "deploy") "receive" "check"))))
      (lambda args
        (catch #t
          (lambda ()
            (if (assoc-ref config "receiverHost")
              (remote (assoc-ref config "receiverHost") node diagnostic)
              (run node diagnostic)))
          (lambda diagnostic-error
            (display "{\"kind\":\"media-dependency-observation\",\"status\":\"unavailable\"}\n")))
        (apply throw args)))))

;; Local deployment must reject an invalid sealed host candidate before media
;; activates any of its units. The main writer retains its own later gate for
;; direct receiving and rollback; build/check and remote routes are unchanged.
(define (receive-local-media config store mode snapshot)
  (when (equal? mode "deploy")
    (run (string-append store "/bin/node")
         (string-append store "/.controller/scripts/check-host.mjs") store))
  (receive-media config store mode))

;; Native targets consume already fabricated common software. LAGOON owns
;; source/assembly verification and the independent authenticated envelope;
;; this caller neither installs packages nor selects another source graph.
(define (native-target snapshot work mode software-file assembly-file source-snapshot)
  (unless (member mode '("build" "deploy" "check-failure" "rollback"))
    (error "unsupported native release mode" mode))
  (when (and (equal? mode "deploy") (not (equal? (getenv "GITHUB_REF") "refs/heads/main")))
    (error "only an approved main merge may deploy a machine snapshot"))
  (let* ((service (canonicalize-path (string-append (dirname (car (command-line))) "/.."))))
    (run "mkdir" "-p" work)
    (write-json (string-append work "/release-invocation.json")
      `(("repository" . ,(getenv "GITHUB_REPOSITORY"))
        ("revision" . ,(capture "git" "-C" snapshot "rev-parse" "HEAD"))
        ("run" . ,(string-append "https://github.com/" (getenv "GITHUB_REPOSITORY")
                               "/actions/runs/" (getenv "GITHUB_RUN_ID")))
        ("runAttempt" . ,(getenv "GITHUB_RUN_ATTEMPT")) ("mode" . ,mode)))
    (let* ((software (read-json software-file))
           (software-store (assoc-ref software "storePath"))
           (runtime (canonicalize-path (string-append software-store "/share/runtime")))
           (node (string-append software-store "/bin/node"))
           (envelope (string-append work "/artifacts")))
      ;; Verify actual immutable bytes/root/NAR before loading any common code.
      (capture "guix" "repl" "--" (string-append service "/scripts/guix-deployment.scm")
               "verify" software-store (assoc-ref software "root") (assoc-ref software "narSha256"))
      (let ((lagoon (capture node "--input-type=module" "-e"
                    "import {createRequire} from 'node:module';import {realpathSync} from 'node:fs';import {join} from 'node:path';const root=realpathSync(process.argv[1]),require=createRequire(join(root,'package.json'));const entry=realpathSync(require.resolve('@red-cup-engineering/computer-deployment-engine/scripts/assemble-portable-runtime.mjs'));if(!entry.startsWith(root+'/'))throw new Error('LAGOON is outside the held common runtime');process.stdout.write(entry);" runtime)))
        (capture node lagoon "target" "--assembly" assembly-file "--software" software-file
                 "--snapshot" source-snapshot "--target-snapshot" snapshot
                 "--target-repository" (getenv "GITHUB_REPOSITORY")
                 "--target-commit" (getenv "GITHUB_SHA") "--output" envelope))
      (let* ((built (json-string->scm (capture "guix" "repl" "--"
                       (string-append service "/scripts/guix-deployment.scm") "build-target"
                       envelope software-file (string-append work "/candidate-root"))))
             (store (assoc-ref built "storePath"))
             (config-file (string-append store "/.controller/machine.json"))
             (config (read-json config-file)))
        (write-json (string-append work (if (equal? mode "rollback") "/prepared-target.json" "/candidate.json"))
          (append built (read-json (string-append work "/release-invocation.json"))))
        ;; Only the sealed Guix constructor output supplies receiving policy.
        (run "rm" "-rf" envelope)
        (receive-candidate (string-append store "/.controller") config store (assoc-ref built "narSha256") mode snapshot config-file)))))

(define (receive-candidate service config store nar mode snapshot config-file)
  (setenv "GUIX_MACHINE_SNAPSHOT" snapshot)
  (when (and (not (equal? mode "rollback")) (assoc-ref config "mediaReceipt") (not (assoc-ref config "receiverHost")))
    (receive-local-media config store mode snapshot))
  (when (getenv "GITHUB_STEP_SUMMARY")
    (call-with-output-file (getenv "GITHUB_STEP_SUMMARY")
      (lambda (p) (format p "Guix candidate: `~a`~%~%NAR SHA256: `~a`~%" store nar))))
  (let ((options (cond ((equal? mode "check-failure") '("--check-failure"))
                       ((equal? mode "build") '("--stage-only"))
                       ((equal? mode "rollback") '("--rollback" "--record-rollback-target")) (else '()))))
    (if (assoc-ref config "receiverHost")
      (begin
        (remote (assoc-ref config "receiverHost") "flock" "--exclusive" "--wait" "900"
          (string-append (assoc-ref config "releaseRoot") "/.release.lock/lease")
          "node" "-e"
          "const {statfsSync}=require('node:fs'),{spawnSync}=require('node:child_process');let s=statfsSync('/gnu/store',{bigint:true});const reserve=4294967296n;if(s.bavail*s.bsize<reserve){const target=reserve+(s.bfree-s.bavail)*s.bsize;const r=spawnSync('guix',['gc','--free-space='+target],{stdio:'inherit',timeout:120000});if(r.error||r.status!==0)throw r.error??new Error('Receiver collection failed');}s=statfsSync('/gnu/store',{bigint:true});if(s.bavail*s.bsize<reserve)throw new Error('Receiver storage reserve unavailable; candidate import refused');")
        (run "guix" "copy" (string-append "--to=" (shell-word (assoc-ref config "receiverHost"))) store)
        (remote (assoc-ref config "receiverHost") "guix" "repl" "--"
          (string-append store "/.controller/scripts/register-candidate-root.scm") store
          (string-append (assoc-ref config "gcRoot") "-received-" (or (getenv "GITHUB_RUN_ID") (number->string (getpid)))
                         "-" (or (getenv "GITHUB_RUN_ATTEMPT") "1")))
        (when (and (not (equal? mode "rollback")) (assoc-ref config "mediaReceipt")) (receive-media config store mode))
        (remote-receive config (string-append store "/.controller")
                        (if (equal? mode "rollback") "previous" store) options))
      (apply run "guix" "repl" "--" (string-append service "/scripts/receive.scm")
             config-file (if (equal? mode "rollback") "previous" store) options))))

(match (cdr (command-line))
 ((snapshot work mode software-file assembly-file source-snapshot)
  (native-target snapshot work mode software-file assembly-file source-snapshot))
 ((snapshot work mode)
  (let* ((config (read-json (string-append snapshot "/machine.json")))
         (spec (json-string->scm (capture-all "node" (string-append (dirname (car (command-line))) "/source-pins.mjs") snapshot)))
         (controller (controller-owner spec))
         (controller-repository (assoc-ref controller "repository"))
         (controller-path (assoc-ref controller "path"))
         (repositories (assoc-ref spec "repositories"))
         (workspace (string-append work "/workspace"))
         (prepared (string-append work "/prepare.json")))
    ;; This fixed source-test mode exits before source assembly, staging or receipt
    ;; promotion. The test program enforces the existing exact snapshot admission.
    (when (member mode '("test" "test-toolchain"))
      (apply run "node" (string-append (dirname (car (command-line))) "/test-controller.mjs") snapshot work
             (if (equal? mode "test-toolchain") '("--toolchain") '()))
      (exit 0))
    (when (and (equal? mode "deploy")
               (not (equal? (getenv "GITHUB_REF") "refs/heads/main")))
      (error "only an approved main merge may deploy a machine snapshot"))
    (when (member mode '("deploy" "check-failure" "rollback"))
      (let ((sha (getenv "GITHUB_SHA")) (repo (getenv "GITHUB_REPOSITORY"))
            (config (read-json (string-append snapshot "/machine.json"))))
        (unless (and sha (= (string-length sha) 40) repo
                     (equal? sha (capture "git" "-C" snapshot "rev-parse" "HEAD"))
                     (equal? repo (assoc-ref config "repository"))
                     (zero? (system* "git" "-C" snapshot "diff" "--quiet" "HEAD")))
          (error "deployment requires the exact committed GitHub machine snapshot"))))
    ;; Verify the exact committed machine directory, whether standalone or
    ;; inside an integrated workspace. Application source outside this scope
    ;; belongs to the workspace and is never an input of this machine contract.
    (run "node" (string-append (dirname (car (command-line))) "/machine-directory.mjs") snapshot)
    (run "mkdir" "-p" work)
    ;; A local builder reclaims earlier runs' scratch and unrooted store items before it needs the space.
    ;; Resolve uses nested source-admission work and cannot reclaim the runner's outer scratch.
    ;; Only local build/deploy own a top-level run directory and its compute lease.
    (when (and (not (assoc-ref config "receiverHost")) (member mode '("build" "deploy")))
      (run "node" (string-append (dirname (car (command-line))) "/reclaim-runner-space.mjs") work))
    ;; The workflow's selected HEAD can differ from its event SHA. Bind the
    ;; invocation before any candidate exists, including failed builds.
    (write-json (string-append work "/release-invocation.json")
      `(("repository" . ,(getenv "GITHUB_REPOSITORY"))
        ("revision" . ,(capture "git" "-C" snapshot "rev-parse" "HEAD"))
        ("run" . ,(and (getenv "GITHUB_REPOSITORY") (getenv "GITHUB_RUN_ID")
          (string-append "https://github.com/" (getenv "GITHUB_REPOSITORY")
                         "/actions/runs/" (getenv "GITHUB_RUN_ID"))))
        ("runAttempt" . ,(getenv "GITHUB_RUN_ATTEMPT")) ("mode" . ,mode)))
    (when (equal? mode "rollback")
      (if (assoc-ref config "receiverHost")
        (remote-receive config (string-append (assoc-ref config "releaseRoot") "/current/.controller") "previous" '("--rollback"))
        (run "guix" "repl" "--" (string-append (dirname (car (command-line))) "/receive.scm")
             (string-append snapshot "/machine.json") "previous" "--rollback"))
        (exit 0))
    (unless (member mode '("build" "deploy" "check-failure" "resolve")) (error "unsupported release mode" mode))
    ;; The machine's own repository is read in place; every repository mounted by gitlink, recursively, is fetched at
    ;; the commit its gitlink records (materialize-sources.mjs).
    (let* ((closure-text (capture-all "node" (string-append (dirname (car (command-line))) "/materialize-sources.mjs") snapshot work))
           (closure (json-string->scm closure-text))
           (resolved (assoc-ref closure "repositories")))
      (let* ((owner (find (lambda (r) (equal? (assoc-ref r "repository") controller-repository)) (vector->list resolved)))
             (service (controller-service-directory (assoc-ref owner "directory") controller-path))
             (lock (string-append snapshot "/dependencies.lock.yaml")))
        (run "rm" "-rf" workspace)
        ;; The preparation plan is the exact closure materialize-sources.mjs resolved (its repositories, graph and graph
        ;; digest), never the declaration source-pins.mjs reads, which is not preparation authority. Its bytes are
        ;; written as they were read: the graph digest binds them, and re-serializing would reorder them.
        (call-with-output-file prepared (lambda (port) (display closure-text port)))
        (when (equal? mode "deploy")
          ;; Native builders need space before sealing their new Guix input.
          ;; The sole writer reconciles failed candidates under its own lease.
          (unless (assoc-ref config "receiverHost")
            (run "guix" "repl" "--" (string-append service "/scripts/receive.scm")
                 (string-append snapshot "/machine.json") "current" "--reconcile")))
        (apply run "node" (string-append service "/scripts/prepare-sources.mjs") prepared (string-append "--output=" workspace)
               (if (equal? mode "resolve") '("--manifests-only") '()))
        (when (equal? mode "resolve")
          (error "DRC-3 metadata resolution held: pnpm10 public hooks do not cover all acquisition paths"))
        (unless (file-exists? lock)
          (error "reviewed dependency lock is missing; resolution remains unqualified"))
        (copy-file lock (string-append workspace "/pnpm-lock.yaml"))
        ;; Independent fixed tooling inputs are supplied by the existing pinned Guix,
        ;; never by the workspace graph or an npm-exec bootstrap.
        (let ((toolchain
          (capture "guix" "repl" "--" (string-append service "/scripts/pinned-guix.scm")
                   (string-append snapshot "/channels.scm") "--require-installed" "build" "--no-grafts"
                   "-L" (string-append service "/src")
                   "-e" "((@ (guix-deployment) dependency-toolchain))")))
          (unless (and (string-prefix? "/gnu/store/" toolchain)
                       (file-exists? (string-append toolchain "/bin/node")))
            (error "Guix returned no dependency toolchain"))
          (run "env" "-i" (string-append "HOME=" work) "LANG=C.UTF-8" "NODE_DISABLE_COMPILE_CACHE=1"
               (string-append toolchain "/bin/node") "--no-addons" "--no-global-search-paths"
               (string-append service "/scripts/design-rules.mjs")
               "--acquire-guix-frozen" toolchain workspace work))
        (let* ((assembled (json-string->scm (capture "node" (string-append service "/scripts/assemble.mjs") workspace snapshot (string-append work "/artifacts"))))
               (closure (assoc-ref assembled "closure"))
               (retired-workspace (begin (run "rm" "-rf" workspace) #t))
               (built (json-string->scm (capture "guix" "repl" "--" (string-append service "/scripts/guix-deployment.scm")
                       "build" (string-append snapshot "/channels.scm") (string-append service "/src")
                       (string-append snapshot "/machine.scm") closure (string-append (assoc-ref config "gcRoot") "-" (or (getenv "GITHUB_RUN_ID") (number->string (getpid))) "-" (or (getenv "GITHUB_RUN_ATTEMPT") "1")))))
               (store (assoc-ref built "storePath")))
          ;; Guix owns the sealed input now; mutable packaging scratch is not a release.
          (run "rm" "-rf" closure)
          (write-json (string-append work "/candidate.json")
            (append built (read-json (string-append work "/release-invocation.json"))))
          (receive-candidate service config store (assoc-ref built "narSha256") mode snapshot (string-append snapshot "/machine.json")))))))
 (_ (error "usage: github-machine-release.scm SNAPSHOT WORK MODE [COMMON-SOFTWARE COMMON-ASSEMBLY COMMON-SNAPSHOT]")))
