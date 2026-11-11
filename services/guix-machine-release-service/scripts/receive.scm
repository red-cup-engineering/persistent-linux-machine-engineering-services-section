;;; The only deployment writer. Run through the machine's pinned Guix.
(use-modules (ice-9 match) (ice-9 popen) (ice-9 rdelim) (ice-9 ftw) (ice-9 textual-ports) (ice-9 regex)
             (ice-9 format) (json) (srfi srfi-1))
(umask #o077)

(define (run . args)
  (unless (zero? (apply system* args)) (error "deployment command failed" (car args))))
(define (capture . args)
  (let* ((port (apply open-pipe* OPEN_READ args))
         (body (let loop ((lines '()))
                 (let ((line (read-line port)))
                   (if (eof-object? line) (string-join (reverse lines) "\n")
                       (loop (cons line lines))))))
         (status (close-pipe port)))
    (unless (zero? status) (error "deployment command failed" (car args)))
    body))
(define (read-json file) (call-with-input-file file json->scm))
(define (field value key) (or (assoc-ref value key) (error "required machine field absent" key)))

;;; The machine's supervisor: systemd's user manager unless machine.json names GNU Shepherd, as a
;;; machine whose PID 1 is not systemd (a container) does. Every unit operation goes through these;
;;; under systemd they are the commands this writer always ran.
(define (shepherd? config)
  (let ((supervisor (or (assoc-ref config "supervisor") "systemd-user")))
    (unless (member supervisor '("systemd-user" "shepherd")) (error "unsupported machine supervisor" supervisor))
    (equal? supervisor "shepherd")))
(define (service-name unit) (if (string-suffix? ".service" unit) (string-drop-right unit 8) unit))
(define (herd-command config . arguments)
  (append (list "herd") (let ((socket (assoc-ref config "supervisorSocket"))) (if socket (list "-s" socket) '())) arguments))
(define (unit-active? config unit)
  (if (shepherd? config)
      (let* ((port (apply open-pipe* OPEN_READ (herd-command config "status" (service-name unit))))
             (text (get-string-all port)))
        (and (zero? (close-pipe port)) (string-contains text "It is running") #t))
      (zero? (system* "systemctl" "--user" "is-active" "--quiet" unit))))
;; A Shepherd machine boots with no services registered, so stopping one that is not running is a no-op.
(define (unit-stop! config unit)
  (if (shepherd? config)
      (when (unit-active? config unit) (apply run (herd-command config "stop" (service-name unit))))
      (let ((properties (capture "systemctl" "--user" "show" unit
                               "--property=LoadState,ActiveState,MainPID,ControlPID,ControlGroup")))
        ;; Collected transient jobs and the first serving installation have no
        ;; loaded unit. Only the exact absent-and-quiescent state is a no-op.
        (if (member "LoadState=not-found" (string-split properties #\newline))
            (unless (and (member "ActiveState=inactive" (string-split properties #\newline))
                         (member "MainPID=0" (string-split properties #\newline))
                         (member "ControlPID=0" (string-split properties #\newline))
                         (member "ControlGroup=" (string-split properties #\newline)))
              (error "absent unit retains a supervisor task" unit))
            (run "systemctl" "--user" "stop" unit)))))
(define (unit-restart! config unit)
  (if (shepherd? config)
      (apply run (herd-command config "restart" (service-name unit)))
      (run "systemctl" "--user" "restart" unit)))
(define (unit-file config unit)
  (if (shepherd? config)
      (string-append (getenv "HOME") "/.config/shepherd/" (service-name unit) ".scm")
      (string-append (getenv "HOME") "/.config/systemd/user/" unit)))
(define (unit-source config store unit)
  (if (shepherd? config)
      (string-append store "/.guix-shepherd/" (service-name unit) ".scm")
      (string-append store "/.guix-systemd/" unit)))
;; Shepherd registers what the installed file declares; a running service of the same name takes the
;; new definition as its replacement, which its next restart starts.
(define (units-reload! config unit)
  (if (shepherd? config)
      (apply run (herd-command config "load" "root" (unit-file config unit)))
      (begin
        (run "systemctl" "--user" "daemon-reload")
        ;; An installed unit that is not enabled stays down when the host restarts: Bare Cedar Fog
        ;; stayed offline after WSL restarted on 2026-10-10 because its unit was installed, never enabled.
        (run "systemctl" "--user" "enable" unit))))
;; Preserve main-unit activation custody separately from its file. A failed
;; first installation owns only links created for this exact candidate.
(define (main-activation-links config unit)
  (if (shepherd? config) '()
    (let ((root (string-append (getenv "HOME") "/.config/systemd/user")))
      (filter-map
        (lambda (name)
          (and (or (string-suffix? ".wants" name) (string-suffix? ".requires" name))
            (let* ((file (string-append root "/" name "/" unit))
                   (st (false-if-exception (lstat file))))
              (and st (eq? (stat:type st) 'symlink) (cons file (readlink file))))))
        (if (file-exists? root) (scandir root) '())))))
(define (restore-main-activation! config store unit unit-file held)
  (unless (shepherd? config)
    (for-each
      (lambda (link)
        (let ((prior (assoc-ref held (car link))))
          (if prior (atomic-link (car link) prior)
            (let ((target (canonicalize-path (string-append (dirname (car link)) "/" (cdr link)))))
              (unless (or (equal? target (canonicalize-path unit-file))
                          (equal? target (canonicalize-path (unit-source config store unit))))
                (error "main activation link is not owned by candidate"))
              (delete-file (car link))))))
      (main-activation-links config unit))
    (for-each (lambda (link) (unless (false-if-exception (lstat (car link)))
                             (atomic-link (car link) (cdr link)))) held)))
;; A line as the run log may show it: credential-shaped values are replaced by [redacted]. Covers
;; Authorization/Bearer values, key/token/secret/password assignments, known token prefixes, and any
;; run of 32 or more token characters that is all hex or mixes digits with upper and lower case.
(define redacted-scheme (make-regexp "(bearer|basic)[[:space:]]+[^[:space:]\",;]+" regexp/icase))
(define redacted-assignment
  (make-regexp "(authorization|[a-z_-]*(key|token|secret|password|passwd))(\"?[[:space:]]*[:=][[:space:]]*\"?)([^[:space:]\",;]+)" regexp/icase))
(define redacted-prefix (make-regexp "(ghp_|gho_|ghs_|ghu_|github_pat_|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]+"))
(define redacted-run (make-regexp "[A-Za-z0-9+/=_-]{32,}"))
(define (redact-line line)
  (let* ((line (regexp-substitute/global #f redacted-scheme line 'pre 1 " [redacted]" 'post))
         (line (regexp-substitute/global #f redacted-assignment line 'pre 1 3 "[redacted]" 'post))
         (line (regexp-substitute/global #f redacted-prefix line 'pre "[redacted]" 'post)))
    (regexp-substitute/global #f redacted-run line 'pre
      (lambda (m)
        (let ((run (match:substring m)))
          (if (or (string-every char-set:hex-digit run)
                  (and (string-any char-set:digit run) (string-any char-set:upper-case run)
                       (string-any char-set:lower-case run)))
              "[redacted]" run)))
      'post)))
;; Run COMMAND with its output and errors joined, printing at most LIMIT redacted lines to the error
;; port, which the run log shows; returns the command's exit value (#f if a signal ended it).
;; SEEN, when given, is handed every line as read, before redaction.
(define (show-redacted limit . command)
  (apply show-redacted-seeing limit (lambda (line) #t) command))
(define (show-redacted-seeing limit seen . command)
  (let* ((port (apply open-pipe* OPEN_READ "sh" "-c" "exec \"$@\" 2>&1" "sh" command))
         (shown (let loop ((count 0))
                  (let ((line (read-line port)))
                    (unless (eof-object? line) (seen line))
                    (cond ((eof-object? line) count)
                          ((< count limit) (format (current-error-port) "~a~%" (redact-line line)) (loop (+ count 1)))
                          (else (loop (+ count 1)))))))
         (status (close-pipe port)))
    (when (> shown limit) (format (current-error-port) "[~a more lines not shown]~%" (- shown limit)))
    (force-output (current-error-port))
    (status:exit-val status)))
;; The supervised unit's own account of a failed live check, printed before recovery replaces it, so a
;; rollback explains itself in the run log: redacted, at most 200 lines, and bounded to 30 seconds so
;; a wedged journal or supervisor cannot hold recovery. It never raises: a missing journal must not
;; mask the failure.
;; Seconds the journal or supervisor status may take before it is stopped.
(define journal-seconds 30)
(define (show-unit-journal config unit)
  (catch #t
    (lambda ()
      (format (current-error-port) "--- ~a before recovery ---~%" unit)
      (apply show-redacted 200 "timeout" "--kill-after=5" (number->string journal-seconds)
             (if (shepherd? config)
                 (herd-command config "status" (service-name unit))
                 (list "journalctl" "--user" "--unit" unit "--since" "-15min" "--lines" "200"
                       "--no-pager" "--output" "short-iso")))
      (format (current-error-port) "--- end ~a ---~%" unit))
    (lambda _ #f)))
;; WORD with each (KEY . VALUE) of PAIRS replaced wherever KEY occurs in it.
(define (substitute-word word pairs)
  (fold (lambda (pair word)
          (let loop ((word word) (start 0))
            (let ((position (string-contains word (car pair) start)))
              (if position
                  (loop (string-append (substring word 0 position) (cdr pair)
                                       (substring word (+ position (string-length (car pair)))))
                        (+ position (string-length (cdr pair))))
                  word))))
        word pairs))
(define (free-bytes path)
  (string->number (car (reverse (string-tokenize (capture "df" "--output=avail" "--block-size=1" path))))))
(define (directory-bytes path)
  (if (file-exists? path)
      (string->number (car (string-tokenize (capture "du" "--summarize" "--bytes" path))))
      0))
;; What a step that copies each directory below ROOT ending in FROM into its sibling ending in INTO may
;; still write: the source's bytes beyond what that sibling already holds, so a finished copy needs none.
(define* (carried-bytes root from into #:optional (depth 12))
  (let ((suffix (string-append "/" from)))
    (fold + 0
      (map (lambda (directory)
             (let ((source (directory-bytes directory))
                   (carried (directory-bytes (string-append (string-drop-right directory (string-length from)) into))))
               (format (current-error-port) "~a: ~a bytes, ~a already in ~a~%" directory source carried into)
               (max 0 (- source carried))))
           (filter (lambda (line) (string-suffix? suffix line))
             (string-split (capture "find" root "-xdev" "-maxdepth" (number->string depth) "-type" "d"
                                    "-path" (string-append "*" suffix) "-prune" "-print")
                           #\newline))))))
;; The steps machine.json declares under preActivation, run after the candidate passed its probe and
;; before anything live changes: the held release keeps serving throughout. Each runs the candidate's
;; own node on a program inside the candidate against the live state, niced, within its time budget and
;; with only HOME, PATH and LANG, its output in the run log. A step that lacks the free space it
;; declares, fails or outruns its budget stops the receive before the switch.
(define* (pre-activation config store #:optional (steps (or (assoc-ref config "preActivation") #())))
  (for-each
    (lambda (step)
      (let* ((pairs `(("{release}" . ,store) ("{stateRoot}" . ,(field config "stateRoot"))))
             (word (lambda (value) (substitute-word value pairs)))
             (name (field step "program"))
             (program (string-append store "/" name))
             (budget (or (assoc-ref step "timeoutSeconds") 3600))
             (space (assoc-ref step "freeSpace"))
             (memory (assoc-ref step "memoryMax"))
             (environment (filter-map (lambda (key) (let ((value (getenv key))) (and value (string-append key "=" value))))
                                      '("HOME" "PATH" "LANG"))))
        (unless (file-exists? program) (error "pre-activation program is not in the candidate" name))
        (when space
          (let* ((root (word (field space "root")))
                 (needed (+ (carried-bytes root (field space "carries") (field space "into"))
                            (or (assoc-ref space "marginBytes") 0)))
                 (free (free-bytes root)))
            (format (current-error-port) "pre-activation ~a: ~a bytes free under ~a, ~a needed~%" name free root needed)
            (when (< free needed) (error "pre-activation step lacks the free space it declares" name))))
        (format (current-error-port) "--- pre-activation ~a (at most ~as) ---~%" name budget)
        (let* ((expect (assoc-ref step "expect"))
               (reported? #f)
               ;; A line that is a JSON object of the expected kind is the step's own report of its work.
               (seen (lambda (line)
                       (when (and expect (not reported?) (string-prefix? "{" (string-trim line)))
                         (catch #t
                           (lambda ()
                             (let ((value (json-string->scm line)))
                               (when (and (list? value) (equal? (assoc-ref value "kind") expect))
                                 (set! reported? #t))))
                           (lambda _ #f)))))
               (status (apply show-redacted-seeing 2000 seen
                        (append
                          ;; Its own scope with a memory ceiling, so pressure ends the step, not the serving unit.
                          (if (and memory (not (shepherd? config)))
                              (list "systemd-run" "--user" "--scope" "--quiet" "--collect"
                                    (string-append "--property=MemoryMax=" memory))
                              '())
                          (list "env" "-i") environment
                          (list "timeout" "--kill-after=60" (number->string budget)
                                "nice" "-n" "10" "ionice" "-c" "3"
                                ;; By its real path: the candidate's top-level entries are links into the
                                ;; admitted runtime, and a script that checks it is the main module compares
                                ;; its argv[1] with the real path Node gives import.meta.url.
                                (string-append store "/bin/node") (canonicalize-path program))
                          (map word (vector->list (or (assoc-ref step "arguments") #())))))))
          (format (current-error-port) "--- end pre-activation ~a ---~%" name)
          (unless (eqv? status 0)
            (error "pre-activation step failed" name status))
          ;; A step that exits 0 without reporting what it did has not shown that it did anything.
          (when (and expect (not reported?))
            (error "pre-activation step did not report its expected kind" name expect)))))
    (vector->list steps)))
;; A release lease serializes release writers, not application writers. An
;; explicit custody transition therefore stops its declared writers and checks
;; both supervisor state and the kernel descendant-task population before moving state.
(define (custody-writers config)
  (let ((spec (assoc-ref config "custodyTransition")))
    (if spec
      (let ((writers (append (vector->list (field spec "writerUnits"))
                              (vector->list (or (assoc-ref spec "writerTimers") #())))))
        (when (shepherd? config) (error "custody quiescence needs an admitted supervisor task readout"))
        (unless (and (member (field config "unit") writers) (<= (length writers) 16)
                     (every (lambda (unit) (and (string? unit) (or (string-suffix? ".service" unit) (string-suffix? ".timer" unit))
                                                (not (string-contains unit "/")))) writers))
          (error "custody transition lacks finite serving writers"))
        (delete-duplicates writers)) '())))
(define (assert-custody-quiescent config)
  (for-each
    (lambda (unit)
      (let* ((properties (capture "systemctl" "--user" "show" unit
                                  "--property=ActiveState,MainPID,ControlPID,ControlGroup"))
             (rows (filter-map (lambda (line)
                     (let ((at (string-index line #\=)))
                       (and at (cons (substring line 0 at) (substring line (+ at 1))))))
                     (string-split properties #\newline)))
             (group (or (assoc-ref rows "ControlGroup") "")))
        (unless (and (member (assoc-ref rows "ActiveState") '("inactive" "failed"))
                     (or (string-suffix? ".timer" unit)
                         (and (equal? (assoc-ref rows "MainPID") "0")
                              (equal? (assoc-ref rows "ControlPID") "0"))))
          (error "custody writer is not quiescent" unit))
        (unless (string-null? group)
          (unless (and (string-prefix? "/" group) (not (string-contains group "..")))
            (error "custody writer cgroup is not admitted" unit))
          ;; cgroup.events population includes descendant groups; checking only
          ;; MainPID or the immediate cgroup.procs would miss delegated workers.
          (let ((events (string-append "/sys/fs/cgroup" group "/cgroup.events")))
            (when (file-exists? events)
              (unless (member "populated 0" (string-split (call-with-input-file events get-string-all) #\newline))
                (error "custody writer still has descendant tasks" unit)))))))
    (custody-writers config)))
(define (stop-custody-writers config)
  ;; Stop activation triggers first; then serving processes and all descendants.
  (for-each (lambda (unit) (unit-stop! config unit))
    (append (filter (lambda (unit) (string-suffix? ".timer" unit)) (custody-writers config))
            (filter (lambda (unit) (string-suffix? ".service" unit)) (custody-writers config))))
  (assert-custody-quiescent config))
(define* (custody-operation config store config-file receipt-file operation
                            #:optional (helper-store store) (held-artifact ""))
  (assert-custody-quiescent config)
  (let ((report (json-string->scm
                  (capture (string-append helper-store "/bin/node")
                           (string-append helper-store "/.controller/scripts/custody-transition.mjs")
                           operation config-file store receipt-file held-artifact))))
    (unless (equal? (assoc-ref report "kind") "machine-custody-transition.v1")
      (error "custody transition did not independently report receiving"))
    (display "Custody transition: ") (scm->json report) (newline)))
;; KEY=VALUE lines as an EnvironmentFile holds them, a quoted value read as written; a later line wins.
(define (environment-of files)
  (let ((table '()))
    (for-each
      (lambda (file)
        (when (file-exists? file)
          (call-with-input-file file
            (lambda (port)
              (let loop ((line (read-line port)))
                (unless (eof-object? line)
                  (let* ((line (string-trim-both line)) (equals (string-index line #\=)))
                    (when (and equals (> equals 0) (not (string-prefix? "#" line)))
                      (let ((value (substring line (+ equals 1))))
                        (set! table (assoc-set! table (substring line 0 equals)
                          (if (string-prefix? "\"" value) (call-with-input-string value read) value))))))
                  (loop (read-line port))))))))
      files)
    (map (lambda (pair) (string-append (car pair) "=" (cdr pair))) table)))
;; The probe must retain the selected storage representation, but none of its live
;; custody or identity paths. Later EnvironmentFile lines own the effective values.
(define (probe-custody-environment files scratch store)
  (let* ((environment (environment-of files))
         (native (find (lambda (line) (string-prefix? "ACTIVITYPUB_STATE_DIR=" line)) environment))
         (native? (and native (not (string-null? (string-trim-both
                    (substring native (string-length "ACTIVITYPUB_STATE_DIR="))))))))
    (append (probe-application-custody store scratch)
    `(("ACTIVITYPUB_STATE_DIR" . ,(if native? (string-append scratch "/activitypub-native") ""))
      ("ACTIVITYPUB_SQLITE_PATH" . ,(if native? "" (string-append scratch "/activitypub.sqlite")))
      ("ACTIVITYPUB_KEYS_DIRECTORY" . ,(string-append scratch "/activitypub-keys"))
      ("ACTIVITYPUB_KEYS_PATH" . ,(string-append scratch "/activitypub-key.json"))
      ("ACTIVITYPUB_INBOX_BEARER_TOKEN_FILE" . ,(string-append scratch "/bearer-token"))))))
;; Hosted factories are constructed in probe mode too. Bind each declared
;; app-private ASSIST store to scratch, through its authenticated capability name.
(define (probe-application-custody store scratch)
  (let* ((instance (read-json (string-append store "/deployment/instance.json")))
         (applications (or (assoc-ref instance "applications") #())))
    (unless (vector? applications) (error "target application declarations must be an array"))
    (filter-map
      (lambda (entry)
        (let* ((configuration (assoc-ref entry "configuration"))
               (bindings (and configuration (assoc-ref configuration "environmentBindings")))
               (name (and bindings (assoc-ref bindings "ASSIST_STATE_ROOT"))))
          (and name
            (begin
              (unless (and (string? name) (string-match "^[A-Z][A-Z0-9_]*$" name))
                (error "declared application custody binding is not an environment name"))
              (cons name (string-append scratch "/applications/" name))))))
      (vector->list applications))))
;; A child process with exactly ENVIRONMENT, its output in LOG; returns its pid.
(define (spawn-with-environment environment log program . arguments)
  (let ((pid (primitive-fork)))
    (if (zero? pid)
        (catch #t
          (lambda ()
            (let ((out (open-file log "a")))
              (dup2 (fileno out) 1) (dup2 (fileno out) 2))
            (apply execle program environment program arguments))
          (lambda _ (primitive-exit 127)))
        pid)))
(define (run-with-environment environment log program . arguments)
  (let ((status (cdr (waitpid (apply spawn-with-environment environment log program arguments)))))
    (unless (zero? (status:exit-val status)) (error "deployment command failed" program))))
(define (atomic-link file target)
  (let ((next (string-append file ".next-" (number->string (getpid)))))
    (symlink target next) (rename-file next file)))
(define* (atomic-copy source target #:optional (mode #o600))
  (let ((next (string-append target ".next-" (number->string (getpid)))))
    (copy-file source next) (chmod next mode) (rename-file next target)))
(define (receipt root outcome value)
  (let ((path (string-append root "/" (number->string (current-time)) "-"
                            (number->string (getpid)) "-" (number->string (get-internal-real-time))
                            "-" outcome ".json")))
    (call-with-output-file path (lambda (p)
      (scm->json (acons "runAttempt" (getenv "GITHUB_RUN_ATTEMPT") value) p) (newline p)))
    (let ((latest (string-append root "/latest.json"))
          (next (string-append root "/.latest-" (number->string (getpid)))))
      (copy-file path next) (rename-file next latest))
    path))

;; The receiver's existing lease owns previous-link selection. Retain the
;; actual target before probes, state custody or switching can begin; the
;; caller source revision and selected artifact revision are distinct facts.
(define (retained-release config store identity)
  (let ((records (filter (lambda (record) (equal? (assoc-ref record "storePath") store))
                        (vector->list (or (assoc-ref config "retainedReleases") #())))))
    (cond ((null? records) #f)
      ((and (= (length records) 1)
            (equal? (assoc-ref (car records) "repository") (assoc-ref identity "machineRepository"))
            (equal? (assoc-ref (car records) "revision") (assoc-ref identity "machineCommit"))
            (equal? (assoc-ref (car records) "transferredTo") (field config "repository"))) (car records))
      (else (error "retained original identity differs from admitted target policy")))))
(define (record-rollback-target config store)
  (let* ((run-id (getenv "GITHUB_RUN_ID")) (attempt (getenv "GITHUB_RUN_ATTEMPT"))
         (source (getenv "GITHUB_SHA")) (repository (getenv "GITHUB_REPOSITORY"))
         (identity (read-json (string-append store "/.metadata/release.json")))
         (revision (assoc-ref identity "machineCommit"))
         (original-repository (assoc-ref identity "machineRepository"))
         (retained (retained-release config store identity)))
    (unless (and run-id attempt source repository
                 (string-match "^[1-9][0-9]*$" run-id) (string-match "^[1-9][0-9]*$" attempt)
                 (string-match "^[0-9a-f]{40}$" source)
                 (string? revision) (string-match "^[0-9a-f]{40}$" revision)
                 (equal? repository (field config "repository"))
                 (or (equal? repository original-repository) retained)
                 (equal? (dirname store) "/gnu/store") (equal? store (canonicalize-path store)))
      (error "rollback selection requires the exact invocation and retained machine artifact"))
    (let* ((nar (capture "guix" "hash" "--serializer=nar" "--format=hex" store))
           (root (field config "receiptRoot"))
           (file (string-append root "/rollback-" run-id "-" attempt ".json"))
           (value `(("kind" . "guix.rollback-target.v1") ("repository" . ,repository)
                    ("revision" . ,source) ("runAttempt" . ,attempt) ("mode" . "rollback")
                    ("run" . ,(string-append "https://github.com/" repository "/actions/runs/" run-id))
                    ("storePath" . ,store) ("narSha256" . ,nar)
                    ("selectedRelease" . (("repository" . ,original-repository) ("revision" . ,revision)
                                          ("storePath" . ,store) ("narSha256" . ,nar)
                                          ("repositoryIdentity" . ,(and retained
                                            `(("id" . ,(field retained "repositoryId")) ("nodeId" . ,(field retained "repositoryNodeId"))
                                              ("from" . ,original-repository) ("to" . ,repository)))))))))
      (unless (string-match "^[0-9a-f]{64}$" nar) (error "rollback artifact has no actual NAR identity"))
      (run "mkdir" "-p" root)
      (if (file-exists? file)
        (unless (equal? (read-json file) value) (error "original rollback selection changed within this invocation"))
        (let ((next (string-append file ".next-" (number->string (getpid)))))
          (call-with-output-file next (lambda (p) (scm->json value p) (newline p)))
          (rename-file next file)))
      file)))
;; Probe termination is one owned effect. A failed termination remains retryable;
;; after successful termination recovery must not stop a collected unit again.
(define (make-probe-stop stop)
  (let ((stopped? #f))
    (lambda ()
      (unless stopped?
        (stop)
        (set! stopped? #t)))))
(define (admitted-health-reading? value expected-artifact)
  (and (eq? (assoc-ref value "ok") #t)
       (or (not expected-artifact) (equal? (assoc-ref value "artifact") expected-artifact))))
;; These observations apply only to the transient unit this receiver started.
;; They can refuse a terminal probe, never grant application readiness.
(define (owned-probe-pending unit)
  (let ((state (capture "systemctl" "--user" "show" "--property=ActiveState" "--value" unit)))
    (when (member state '("inactive" "failed"))
      (error "owned candidate probe terminated before receiving"))))
(define (stop-owned-probe unit)
  (unless (equal? (capture "systemctl" "--user" "show" "--property=LoadState" "--value" unit) "not-found")
    (run "systemctl" "--user" "stop" unit)))
(define* (health url #:optional expected-artifact pending-check)
  ;; Bound elapsed time even when curl itself reaches its three-second timeout.
  (let ((deadline (+ (get-internal-real-time) (* 600 internal-time-units-per-second))))
    (let loop ()
      ;; A confirmed terminal owned probe cannot become healthy. This check
      ;; does not replace the application's readiness/identity predicate.
      (when pending-check (pending-check))
      (catch #t
        (lambda ()
          (let ((value (json-string->scm (capture "curl" "--fail" "--silent" "--show-error" "--max-time" "3" url))))
          ;; The owning health endpoint checks loaded/linked families and
          ;; permits a usable degraded node. Do not replace that proof with
          ;; a second, conflicting supervisor-state interpretation.
          (if (admitted-health-reading? value expected-artifact) #t
                (error "candidate is not ready"))))
        (lambda args
          (if (< (get-internal-real-time) deadline)
              (begin (sleep 3) (loop))
              (apply throw args)))))))

(define (configuration-commands config action store)
  (for-each
    (lambda (spec)
      (let ((command (assoc-ref spec action)))
        (when command
          (apply run (map (lambda (word)
            (let ((position (string-contains word "{release}")))
              (if position (string-append (substring word 0 position) store
                                          (substring word (+ position 9))) word)))
                         (vector->list command))))))
    (vector->list (or (assoc-ref config "configurationFiles") #()))))

(define (root-release-generations config store current previous)
  (let* ((root (field config "gcRoot"))
         (script (string-append store "/.controller/scripts/register-candidate-root.scm")))
    (run "guix" "repl" "--" script store root)
    (when (and current (string-prefix? "/gnu/store/" current))
      (run "guix" "repl" "--" script current (string-append root "-current")))
    (when (and previous (string-prefix? "/gnu/store/" previous))
      (run "guix" "repl" "--" script previous (string-append root "-previous")))
    ;; Completed build/stage roots are superseded only under the writer lease.
    ;; Current and previous have stable public roots before any root is retired.
    (for-each
      (lambda (name)
        (let ((file (string-append (dirname root) "/" name)))
          (when (and (string-prefix? (string-append (basename root) "-") name)
                     (not (member name (list (string-append (basename root) "-current")
                                             (string-append (basename root) "-previous"))))
                     (eq? (stat:type (lstat file)) 'symlink))
            (delete-file file))))
      (scandir (dirname root)))))

(define (reconcile-release-roots config)
  ;; Failed promotion may leave the auxiliary Guix profile on its candidate.
  ;; The application links remain authoritative; protect both before retiring
  ;; obsolete candidate/profile roots. This operation never switches code.
  (let* ((root (field config "releaseRoot"))
         (current-link (string-append root "/current"))
         (previous-link (string-append root "/previous"))
         (current (and (file-exists? current-link) (canonicalize-path current-link)))
         (previous (and (file-exists? previous-link) (canonicalize-path previous-link))))
    (when (and current (string-prefix? "/gnu/store/" current))
      (root-release-generations config current current previous)
      (run "guix" "package" (string-append "--profile=" (field config "guixProfile")) "--install" current)
      (run "guix" "package" (string-append "--profile=" (field config "guixProfile")) "--delete-generations"))
    ;; Sealing temporarily holds both the checked closure and its store input.
    ;; Collect before assembly so a native build can retain current/previous.
    (run "node" (string-append (dirname (car (command-line))) "/release-storage.mjs")
         (cadr (command-line)) "--locked")))

(define (retain-release-roots config store current previous)
    (root-release-generations config store current previous)
    ;; Guix deduplicates immutable files and collects only unrooted store items.
    (let ((free (string->number (car (reverse (string-tokenize
                  (capture "df" "--output=avail" "--block-size=1" "/gnu/store")))))))
      (when (< free 2147483648)
        (system* "guix" "gc" "--optimize")
        (system* "guix" "gc" "--free-space=2GB"))))

;; Only runtime declarations from the exact hash-bound original are selected.
;; Successor state/custody, receipt and lease authority are never overwritten.
(define retained-runtime-fields
  '("configurationFiles" "auxiliaryChecks" "auxiliaryUnits" "restartAuxiliaryUnits"
    "retiredDeployers" "retiredConfigurationFiles" "mediaReceipt"))
(define (retained-runtime-policy policy store)
  (let* ((original (read-json (string-append store "/.controller/machine.json")))
         (runtime (append
           (filter (lambda (pair) (not (member (car pair) retained-runtime-fields))) policy)
           (filter (lambda (pair) (member (car pair) retained-runtime-fields)) original)))
         (selected-paths (map (lambda (file) (field file "path"))
                             (vector->list (or (assoc-ref original "configurationFiles") #()))))
         ;; Retire successor-only managed configurations on successful rollback;
         ;; the same existing backups restore them if any receiving step fails.
         (retired (append (vector->list (or (assoc-ref original "retiredConfigurationFiles") #()))
           (filter (lambda (file) (not (member (field file "path") selected-paths)))
                   (vector->list (or (assoc-ref policy "configurationFiles") #()))))))
    (acons "retiredConfigurationFiles" (list->vector retired)
           (filter (lambda (pair) (not (equal? (car pair) "retiredConfigurationFiles"))) runtime))))
(define* (receive config store failure-test? stage-only? config-file #:optional (rollback? #f))
  (let* ((policy config)
         (config (if (and rollback? (retained-release policy store (read-json (string-append store "/.metadata/release.json"))))
                     (retained-runtime-policy policy store) policy))
         (name (field config "name")) (root (field config "releaseRoot"))
         (profile (string-append root "/current"))
         (unit (field config "unit")) (env-file (field config "environmentFile"))
         (previous (and (file-exists? profile) (readlink profile)))
         ;; Capture the held identity before current can name the candidate.
         ;; Keep the raw link separately so relative/aliased links restore intact.
         (previous-artifact (and previous (canonicalize-path profile)))
         (previous-link (string-append root "/previous"))
         (held-previous (and (file-exists? previous-link) (readlink previous-link)))
         (unit-file (unit-file config unit))
         ;; A machine that boots fresh (a container) has no unit installed before its first receiving.
         (old-unit-link (and (false-if-exception (lstat unit-file))
                             (eq? (stat:type (lstat unit-file)) 'symlink) (readlink unit-file)))
         (old-unit? (or old-unit-link (file-exists? unit-file)))
         (was-running? (unit-active? config unit))
         (held-main-activation (main-activation-links config unit))
         (main-unit-installed? #f)
         (receipts (field config "receiptRoot"))
         (scratch (mkdtemp (string-append root "/.probe-XXXXXX")))
         (unit-backup (string-append scratch "/main.unit"))
         (probe-env (string-append scratch "/probe.env"))
         (probe (string-append name "-guix-probe-" (basename scratch)))
         (probe-listen
           (string-append "127.0.0.1:"
             (string-trim-both
               (capture (string-append store "/bin/node") "--input-type=module" "--eval"
                 "import {createServer} from 'node:net'; const s=createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p));});"))))
         (stage "staging")
         (identity (read-json (string-append store "/.metadata/release.json")))
         (revision (assoc-ref identity "machineCommit"))
         (repository (assoc-ref identity "machineRepository"))
         (run-url (and (getenv "GITHUB_REPOSITORY") (getenv "GITHUB_RUN_ID")
                    (string-append "https://github.com/" (getenv "GITHUB_REPOSITORY")
                                   "/actions/runs/" (getenv "GITHUB_RUN_ID"))))
         (stopped? #f)
         (custody-receipt (string-append scratch "/custody-transition.json"))
         (custody-helper-store (if rollback? previous-artifact store))
         (held-custody-writers (map (lambda (unit) (cons unit (unit-active? config unit))) (custody-writers config)))
         (storage-units
           (if (and (not (shepherd? config))
                    (file-exists? (string-append store "/.guix-systemd/" name "-storage.timer")))
               (list (string-append name "-storage.service") (string-append name "-storage.timer")) '()))
         (activated-units (append (vector->list (or (assoc-ref config "restartAuxiliaryUnits") #()))
                                 (filter (lambda (unit) (string-suffix? ".timer" unit)) storage-units)))
         (held-unit-actives (map (lambda (name) (cons name (unit-active? config name))) activated-units))
         ;; Under Shepherd the probe is this writer's own child process, not a transient unit.
         (probe-pid #f)
         (probe-created? #f)
         (probe-pending!
           (lambda ()
             (if (shepherd? config)
                 (when probe-pid
                   (let ((terminated (waitpid probe-pid WNOHANG)))
                     (unless (zero? (car terminated))
                       (set! probe-pid #f)
                       (error "owned candidate probe terminated before receiving"))))
                 (owned-probe-pending probe))))
         (stop-probe!
           (make-probe-stop
             (lambda ()
               (if (shepherd? config)
                   (when probe-pid
                     (false-if-exception (kill probe-pid SIGTERM))
                     (false-if-exception (waitpid probe-pid))
                     (set! probe-pid #f))
                   (when probe-created?
                     ;; A collected transient unit has already terminated. A
                     ;; failed query or an actual stop failure remains a failure.
                     (stop-owned-probe probe))))))
         (managed-files
           (append
             (if (shepherd? config) '()
                 (map (lambda (name) (cons (string-append (getenv "HOME") "/.config/systemd/user/" name)
                                         (string-append store "/.guix-systemd/" name)))
                      (append (vector->list (or (assoc-ref config "auxiliaryUnits") #())) storage-units)))
             (map (lambda (spec) (cons (field spec "path") (string-append store "/bin/owning-repository-release-only")))
                  (vector->list (or (assoc-ref config "retiredDeployers") #())))
             (map (lambda (spec) (cons (field spec "path") (string-append store "/" (field spec "source"))))
                  (vector->list (or (assoc-ref config "configurationFiles") #())))
             (map (lambda (spec) (cons (field spec "path") #f))
                  (vector->list (or (assoc-ref config "retiredConfigurationFiles") #())))))
         (managed-backups '())
         (managed-changed? #f)
         (credential-baseline #f)
         (credential-reading #f))
    (unless (and (or (equal? repository (field config "repository"))
                     (and rollback? (retained-release config store identity)))
                 (string? revision) (= (string-length revision) 40)
                 (equal? (field config "stateCompatibility") "preserve-existing"))
      (error "candidate identity or state contract is not admitted"))
    ;; Shepherd realizes the main service and simple auxiliaries in one file; oneshot and timed units
    ;; have no Shepherd form yet, so a machine declaring auxiliaries is refused rather than half received.
    (when (and (shepherd? config) (pair? (vector->list (or (assoc-ref config "auxiliaryUnits") #()))))
      (error "auxiliary units are not yet received under Shepherd"))
    (run "mkdir" "-p" receipts)
    (retain-release-roots config store previous held-previous)
    (catch #t
      (lambda ()
        (set! stage "host-check")
        ;; Current receiving source validates current eligibility or the exact
        ;; admitted retained programme. Never execute an old suite-driven gate.
        (unless rollback?
          (run (string-append store "/bin/node")
               (string-append store "/.controller/scripts/check-host.mjs") store))
        (set! stage "staging")
        ;; The app's probe mode suppresses clocks, remote delivery and companions.
        ;; It gets empty state and does not inherit the live data root.
        ;; EnvironmentFile wins over systemd Environment settings. Append probe
        ;; overrides to a private scratch file so the live roots cannot win.
        (call-with-output-file probe-env
          (lambda (p)
            (display (call-with-input-file env-file get-string-all) p)
            (newline p)
            (display (call-with-input-file (string-append store "/.guix-systemd/environment") get-string-all) p)
            (newline p)
            (for-each (lambda (pair) (format p "~a=~s~%" (car pair) (cdr pair)))
              (append `(("METROPLAT_PROBE" . "1")
                ("METROPLAT_PROBE_LISTEN" . ,probe-listen)
                ("FELTOS_ARTIFACT" . ,store)
                ("FELTOS_WORLD" . ,(string-append store "/deployment/host.json"))
                ("METROPLAT_INSTANCE" . ,(string-append store "/deployment/instance.json"))
                ("NODE_OPTIONS" . "--max-old-space-size=384 --disable-sigusr1")
                ("FELTOS_ENTERPRISE_HOST" . ,(string-append store "/deployment/host.json"))
                ("METROPLAT_REPOSITORY_ROOT" . ,store)
                ("METROPLAT_WEB_STATE_DIR" . ,(string-append scratch "/state"))
                ("METROPLAT_WEB_DATA_DIR" . ,(string-append scratch "/data"))
                ("METROPLAT_DATA_ROOT" . ,(string-append scratch "/settlement"))
                ("AGENCY_ACTS_LOG" . ,(string-append scratch "/acts.jsonl")))
                (probe-custody-environment
                  (list env-file (string-append store "/.guix-systemd/environment")) scratch store)))))
        (if (shepherd? config)
          ;; Its own child, with exactly the probe environment; its output stays in the scratch.
          (set! probe-pid (spawn-with-environment (environment-of (list probe-env)) (string-append scratch "/probe.log")
                                                  (string-append store "/bin/" name)))
          (begin
        ;; Cancellation can leave the preceding transient probe loaded. The
        ;; writer lease makes its isolated unit ours to reconcile before reuse.
        (system* "systemctl" "--user" "stop" probe)
        (system* "systemctl" "--user" "reset-failed" probe)
        (set! probe-created? #t)
        (run "systemd-run" "--user" "--collect" "--quiet" "--nice=0"
             (string-append "--unit=" probe)
             (string-append "--property=EnvironmentFile=" probe-env)
             "--property=CPUWeight=100" "--property=IOWeight=100"
             "--property=MemoryMax=640M" "--property=OOMScoreAdjust=1000"
             "--setenv=METROPLAT_PROBE=1" (string-append "--setenv=METROPLAT_PROBE_LISTEN=" probe-listen)
             (string-append "--setenv=FELTOS_ENTERPRISE_HOST=" store "/deployment/host.json")
             (string-append "--setenv=METROPLAT_REPOSITORY_ROOT=" store)
             (string-append "--setenv=METROPLAT_WEB_STATE_DIR=" scratch "/state")
             (string-append "--setenv=METROPLAT_WEB_DATA_DIR=" scratch "/data")
             (string-append "--setenv=METROPLAT_DATA_ROOT=" scratch "/settlement")
             (string-append store "/bin/" name))))
        (health (string-append "http://" probe-listen "/healthz") store probe-pending!)
        (set! stage "auxiliary-check")
        (for-each
          (lambda (check)
            (let* ((aux-unit (field check "unit"))
                   (unit-text (call-with-input-file (string-append store "/.guix-systemd/" aux-unit) get-string-all))
                   (files (filter-map (lambda (line)
                            (and (string-prefix? "EnvironmentFile=" line)
                                 (substring line (string-length "EnvironmentFile="))))
                            (string-split unit-text #\newline))))
              (if (shepherd? config)
                (run-with-environment (environment-of files) (string-append scratch "/auxiliary-check.log")
                                      (string-append store "/bin/node") (string-append store "/" (field check "program")))
                (apply run "systemd-run" "--user" "--wait" "--pipe" "--collect" "--quiet"
                           "--property=MemoryMax=640M"
                           (append (map (lambda (file) (string-append "--property=EnvironmentFile=" file)) files)
                                   (list (string-append store "/bin/node")
                                         (string-append store "/" (field check "program"))))))))
          (vector->list (or (assoc-ref config "auxiliaryChecks") #())))
        (configuration-commands config "validate" store)
        (set! stage "pre-switch-check")
        (if stage-only?
          (begin
          (stop-probe!)
          (delete-file probe-env)
          (receipt receipts "staged" `(("outcome" . "staged") ("storePath" . ,store)
                                      ("retained" . ,previous) ("machine" . ,name)
                                      ("revision" . ,revision) ("repository" . ,repository)
                                      ("run" . ,run-url) ("stage" . "pre-switch-check")
                                      ("at" . ,(strftime "%FT%TZ" (gmtime (current-time))))))
          )
          (begin
        (when failure-test? (error "deliberate pre-switch check failure"))
        (stop-probe!)
        (delete-file probe-env)
        (set! stage "pre-activation")
        (pre-activation config store)
        (when (and old-unit? (not old-unit-link)) (copy-file unit-file unit-backup))
        (set! stage "switch")
        (unit-stop! config unit)
        (set! stopped? #t)
        ;; Releases use the existing state contract. Journals and databases stay
        ;; in their original custody; code rollback never erases newly received work.
        (unless (equal? (field config "stateCompatibility") "preserve-existing")
          (error "state migration requires a separately reviewed recovery procedure"))
        (when (assoc-ref config "custodyTransition")
          (stop-custody-writers config)
          (set! stage "custody-prepare")
          (custody-operation config store config-file custody-receipt
            (if rollback? "prepare-rollback" "prepare") custody-helper-store (or previous-artifact ""))
          (set! stage "custody-bind")
          (custody-operation config store config-file custody-receipt "activate" custody-helper-store)
          (set! stage "custody-receive")
          ;; A pre-conversion generation is received through its retained exact
          ;; custody and own live health, not a converter absent from old code.
          (unless rollback?
            (custody-operation config store config-file custody-receipt "receive" custody-helper-store)
            (let ((extra (assoc-ref (field config "custodyTransition") "receive")))
              (when extra (pre-activation config store (vector extra))))))
        (when previous (atomic-link (string-append root "/previous") previous))
        (when (and previous (not (string-prefix? "/gnu/store/" previous)))
          (unless (file-exists? (string-append profile ".before-guix"))
            (atomic-link (string-append profile ".before-guix") previous)))
        ;; Guix retains generations as GC roots; current/previous name the exact
        ;; application outputs, never a mutable machine checkout.
        (run "guix" "package" (string-append "--profile=" (field config "guixProfile")) "--install" store)
        (atomic-link profile store)
        (run "mkdir" "-p" (dirname unit-file))
        (atomic-copy (unit-source config store unit) unit-file)
        (set! main-unit-installed? #t)
        ;; Save and install every managed controller/unit atomically. Ongoing
        ;; newsroom jobs keep their old immutable programs until they finish;
        ;; timers use the new generation on their next invocation.
        (when (assoc-ref config "custodyTransition")
          (custody-operation config store config-file custody-receipt "retire-check" custody-helper-store))
        (set! managed-backups
          (map (lambda (file)
                 (let* ((path (car file)) (backup (string-append scratch "/managed-" (number->string (length managed-backups)) "-" (basename path)))
                        (exists? (or (file-exists? path) (false-if-exception (lstat path))))
                        (link (and exists? (eq? (stat:type (lstat path)) 'symlink) (readlink path))))
                   (when (and exists? (not link)) (copy-file path backup))
                   (list path backup exists? link))) managed-files))
        (set! managed-changed? #t)
        (for-each (lambda (file)
                    (if (cdr file)
                      (atomic-copy (cdr file) (car file) (if (string-contains (cdr file) "/bin/") #o555 #o600))
                      (when (or (file-exists? (car file)) (false-if-exception (lstat (car file))))
                        (delete-file (car file))))) managed-files)
        (units-reload! config unit)
        (set! stage "credential-baseline")
        (set! credential-baseline
          (capture (string-append store "/bin/node")
                   (string-append store "/.controller/scripts/credential-unit-receiving.mjs")
                   store "baseline"))
        (set! stage "switch")
        (unit-restart! config unit)
        (for-each (lambda (held)
                    (when (and (cdr held) (not (equal? (car held) unit))
                               (not (member (car held) (vector->list (or (assoc-ref (assoc-ref config "custodyTransition") "retiredWriterUnits") #())))))
                      (unit-restart! config (car held)))) held-custody-writers)
        (for-each (lambda (name) (unit-restart! config name)) activated-units)
        (set! stage "credential-unit-check")
        (set! credential-reading
          (json-string->scm
            (capture (string-append store "/bin/node")
                     (string-append store "/.controller/scripts/credential-unit-receiving.mjs")
                     store "verify" credential-baseline)))
        ;; A fixed value-free projection, also retained in the correlated receipt.
        (display "Credential unit receiving: ") (scm->json credential-reading) (newline)
        ;; The declared restarts complete the admitted credential invocation.
        ;; Verify it before unrelated reload commands can discard its runtime proof.
        (set! stage "configuration-reload")
        (configuration-commands config "reload" store)
        (set! stage "live-check")
        (health (field config "health") store)
        ;; Successor receiving is separate from idempotent configuration reload.
        ;; Recovery reloads the held configuration without asserting new capability.
        (configuration-commands config "receive" store)
        ;; Stable roots retain both rollback targets; older profile generations
        ;; no longer retain every historical build forever.
        (root-release-generations config store store previous)
        ;; Retention keeps current, the release it replaced and any release a unit names; it removes
        ;; older release trees and stale scratch, and deletes the other profile generations by an
        ;; explicit list. It never fails a receive that has passed its live check: if it cannot run,
        ;; the profile is trimmed to its current generation as before.
        (unless (zero? (system* (string-append store "/bin/node")
                                (string-append store "/.controller/scripts/release-retention.mjs")
                                "--release-root" root "--profile" (field config "guixProfile")))
          (run "guix" "package" (string-append "--profile=" (field config "guixProfile")) "--delete-generations"))
        (system* "guix" "gc" "--free-space=2GB")
        (receipt receipts "success" `(("outcome" . "success") ("storePath" . ,store)
                                      ("previous" . ,previous) ("previousArtifact" . ,previous-artifact)
                                      ("custody" . ,(and (assoc-ref config "custodyTransition") (read-json custody-receipt)))
                                      ("machine" . ,name)
                                      ("revision" . ,revision) ("repository" . ,repository)
                                      ("run" . ,run-url) ("stage" . "live-check")
                                      ("credentialUnit" . ,credential-reading)
                                      ("at" . ,(strftime "%FT%TZ" (gmtime (current-time)))))))))
      (lambda args
        ;; Recovery cannot replace the candidate's original exception or stage.
        ;; Only fixed step names are reported, never exception arguments/outputs.
        (let ((recovery-stage "probe-stop") (failed-steps '())
              (live-check "not-attempted"))
          ;; A candidate that started but never answered says why in its own journal; show it first.
          (when (equal? stage "live-check") (show-unit-journal config unit))
          (define (failed!) (set! failed-steps (append failed-steps (list recovery-stage))))
          (define (attempt step thunk)
            (set! recovery-stage step)
            (catch #t thunk (lambda recovery-args (failed!))))
          (define (record-failure outcome value)
            (catch #t
              (lambda () (receipt receipts outcome value))
              (lambda receipt-args
                ;; Even unavailable receipt storage must not mask the first error.
                (format (current-error-port)
                  "{\"kind\":\"machine-release-receipt\",\"outcome\":\"~a\",\"status\":\"unavailable\"}~%" outcome))))
          ;; Isolated probe cleanup is independent of restoration of live code.
          (attempt "probe-stop" (lambda () (stop-probe!)))
          (attempt "probe-environment-cleanup"
            (lambda () (when (file-exists? probe-env) (delete-file probe-env))))
          (catch #t
            (lambda ()
              (when stopped?
                (set! recovery-stage "restore-main-stop")
                (unit-stop! config unit))
              (when (and stopped? (assoc-ref config "custodyTransition"))
                (set! recovery-stage "restore-custody-stop")
                (stop-custody-writers config)
                (set! recovery-stage "restore-custody")
                (custody-operation config store config-file custody-receipt "restore" custody-helper-store))
              (when managed-changed?
                (set! recovery-stage "restore-auxiliary-stop")
                (for-each (lambda (name) (unit-stop! config name)) activated-units)
                (set! recovery-stage "restore-managed-files")
                (for-each (lambda (saved)
                            (match saved
                              ((path backup exists? link)
                               (cond (link (atomic-link path link))
                                     (exists? (atomic-copy backup path (stat:perms (stat backup))))
                                     ((or (file-exists? path) (false-if-exception (lstat path))) (delete-file path)))))) managed-backups))
              (when (and stopped? (not previous))
                (when was-running?
                  (set! recovery-stage "restore-generation-unavailable")
                  (error "a formerly serving unit has no held generation"))
                (set! recovery-stage "restore-first-install-stop")
                (unit-stop! config unit)
                (when main-unit-installed?
                  (set! recovery-stage "restore-main-activation")
                  (restore-main-activation! config store unit unit-file held-main-activation)
                  (set! recovery-stage "restore-main-unit")
                  (cond (old-unit-link (atomic-link unit-file old-unit-link))
                        (old-unit? (atomic-copy unit-backup unit-file))
                        ((file-exists? unit-file)
                         (unless (equal? (call-with-input-file unit-file get-string-all)
                                         (call-with-input-file (unit-source config store unit) get-string-all))
                           (error "first-install main unit is not candidate-owned"))
                         (delete-file unit-file))))
                (when (and (file-exists? profile) (equal? (canonicalize-path profile) store))
                  (delete-file profile))
                (set! recovery-stage "restore-first-install-reload")
                (if (shepherd? config)
                    (when main-unit-installed? (apply run (herd-command config "unload" "root" (service-name unit))))
                    (run "systemctl" "--user" "daemon-reload")))
              (when (and previous stopped?)
                ;; A failed Guix command may already have changed its profile.
                ;; Restore every prerequisite before any recovery activation.
                (set! recovery-stage "restore-generation")
                (atomic-link profile previous)
                (if held-previous (atomic-link previous-link held-previous)
                    (when (file-exists? previous-link) (delete-file previous-link)))
                (set! recovery-stage "restore-main-activation")
                (when main-unit-installed? (restore-main-activation! config store unit unit-file held-main-activation))
                (set! recovery-stage "restore-main-unit")
                (cond (old-unit-link (atomic-link unit-file old-unit-link))
                      (old-unit? (atomic-copy unit-backup unit-file))
                      ((file-exists? unit-file)
                       (unless (equal? (call-with-input-file unit-file get-string-all)
                                       (call-with-input-file (unit-source config store unit) get-string-all))
                         (error "restored-absence main unit is not candidate-owned"))
                       (delete-file unit-file)))
                (set! recovery-stage "restore-daemon-reload")
                (if (shepherd? config)
                    (when old-unit? (apply run (herd-command config "load" "root" unit-file)))
                    (run "systemctl" "--user" "daemon-reload"))
                (set! recovery-stage "restore-configuration-reload")
                (configuration-commands config "reload" store)
                (set! recovery-stage "restore-auxiliary-restart")
                (for-each (lambda (held) (when (cdr held) (unit-restart! config (car held)))) held-unit-actives)
                (for-each (lambda (held)
                            (when (and (cdr held) (not (equal? (car held) unit)))
                              (unit-restart! config (car held)))) held-custody-writers)
                (when was-running?
                  (set! recovery-stage "restore-main-restart")
                  (unit-restart! config unit)
                  (set! recovery-stage "restore-live-check")
                  (set! live-check "failed")
                  (health (field config "health") previous-artifact)
                  (set! live-check "passed"))))
            ;; Fail closed: nothing after a failed restoration prerequisite runs.
            (lambda recovery-args (failed!)))
          (let* ((recovery `(("status" . ,(if (pair? failed-steps) "incomplete"
                                             (if stopped? "steps-completed" "not-required")))
                             ("failedSteps" . ,(list->vector failed-steps))
                             ("liveCheck" . ,live-check)
                             ("expectedArtifact" . ,previous-artifact)))
                 (context `(("storePath" . ,store) ("retained" . ,previous) ("machine" . ,name)
                            ("revision" . ,revision) ("repository" . ,repository) ("run" . ,run-url)
                            ("at" . ,(strftime "%FT%TZ" (gmtime (current-time))))
                            ("recovery" . ,recovery))))
            (when (pair? failed-steps)
              (record-failure "recovery-failure"
                (append `(("outcome" . "recovery-failure") ("stage" . ,(last failed-steps))
                          ("originalStage" . ,stage)
                          ("reason" . "Recovery is incomplete; retained identifies the held target, not proof of live restoration.")) context)))
            (record-failure "failure"
              (append `(("outcome" . "failure") ("stage" . ,stage)
                        ("reason" . ,(string-append "Candidate failed at " stage "; recovery is reported separately."))) context))))
        (apply throw args)))))

(match (cdr (command-line))
  ((config-file store . options)
   (let* ((config (read-json config-file)) (root (field config "releaseRoot"))
          (lease (string-append root "/.release.lock/lease")))
     (unless (or (equal? store "previous") (equal? store "current") (string-prefix? "/gnu/store/" store))
       (error "candidate must be a Guix store output"))
     (run "mkdir" "-p" (dirname lease))
     (if (equal? (getenv "GUIX_MACHINE_RELEASE_LOCKED") "1")
         (if (and (equal? store "current") (member "--reconcile" options))
           (reconcile-release-roots config)
         (let ((candidate (if (equal? store "previous") (canonicalize-path (string-append root "/previous")) store)))
           (unless (string-prefix? "/gnu/store/" candidate) (error "rollback requires a retained Guix generation"))
           (when (equal? store "previous")
             (setenv "GUIX_MACHINE_SNAPSHOT" candidate)
             (let* ((identity (read-json (string-append candidate "/.metadata/release.json")))
                    (retained (retained-release config candidate identity))
                    (checker (string-append (dirname (car (command-line))) "/check-host.mjs")))
               (apply run (string-append candidate "/bin/node") checker candidate
                      (if retained (list "--retained" config-file) '()))))
           (when (member "--record-rollback-target" options)
             (unless (equal? store "previous") (error "rollback target custody requires previous selection"))
             (record-rollback-target config candidate))
           (display (receive config candidate (member "--check-failure" options) (member "--stage-only" options) config-file (equal? store "previous"))) (newline)))
         (begin
           (setenv "GUIX_MACHINE_RELEASE_LOCKED" "1")
           (apply run "flock" "--exclusive" "--wait" "900" lease "guix" "repl" "--"
                  (car (command-line)) config-file store options)))))
  (_ (error "usage: receive.scm MACHINE.json STORE [--check-failure] [--record-rollback-target]")))
