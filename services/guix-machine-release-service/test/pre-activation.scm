;; Exercise the receiver's actual pre-activation steps with inert programs in a temporary candidate.
;; Never load the script's command-line dispatch or perform a real service action.
(use-modules (ice-9 match) (ice-9 popen) (ice-9 rdelim) (ice-9 ftw) (ice-9 textual-ports) (ice-9 regex)
             (ice-9 format) (json) (srfi srfi-1))
(call-with-input-file (string-append (dirname (car (command-line))) "/../scripts/receive.scm")
  (lambda (p)
    (let loop ((form (read p)))
      (unless (eof-object? form)
        (when (and (pair? form) (memq (car form) '(define define*)))
          (eval form (current-module)))
        (loop (read p))))))
(define (assert value message) (unless value (error message)))
(define (write-text path text) (call-with-output-file path (lambda (p) (display text p))))
(define (write-bytes path count) (write-text path (make-string count #\x)))
(define (mkdir-p path)
  (unless (file-exists? path) (mkdir-p (dirname path)) (mkdir path)))
(define root (mkdtemp (string-append (or (getenv "TMPDIR") "/tmp") "/pre-activation-XXXXXX")))
(define store (string-append root "/candidate"))
(define state (string-append root "/state"))
(define seen (string-append state "/seen"))
(mkdir-p (string-append store "/bin"))
(mkdir-p (string-append store "/steps"))
(mkdir-p state)
;; The candidate's node is a shell here; each step is a shell program the receiver hands to it.
(write-text (string-append store "/bin/node") "#!/bin/sh\nexec sh \"$@\"\n")
(chmod (string-append store "/bin/node") #o755)
(write-text (string-append store "/steps/record.sh")
  (string-append "printf '%s\\n' \"$@\" > \"$2/seen\"; printf '%s\\n' \"${INERT_PRIVATE:-absent}\" >> \"$2/seen\"; "
                 "echo \"carried GITHUB_TOKEN=ghp_PlantedToken0123456789\"; echo 'Authorization: Bearer planted.bearer.value' >&2; "
                 "exit \"$4\"\n"))
(write-text (string-append store "/steps/sleep.sh") "sleep 5\n")
;; Prints its one argument as a line, or nothing when given none; always exits 0.
(write-text (string-append store "/steps/report.sh") "[ $# -gt 0 ] && printf '%s\\n' \"$1\"; exit 0\n")
(setenv "INERT_PRIVATE" "INERT_PRIVATE_VALUE")
(define (config . steps)
  `(("stateRoot" . ,state) ("preActivation" . ,(list->vector steps))))
(define (record-step code . more)
  `(("program" . "steps/record.sh") ("arguments" . #("--root" "{stateRoot}" "--exit" ,code "{release}/x")) ,@more))
;; The reason a step stopped the receive: error raises misc-error with ("~A ~S" (message . irritants)).
(define shown "")
(define (outcome thunk)
  (let ((errors (open-output-string)))
    (parameterize ((current-error-port errors))
      (catch #t (lambda () (thunk) (set! shown (get-output-string errors)) 'passed)
        (lambda (key . args) (match args ((_ _ (message . _) . _) message) (_ key)))))))
(define (stopped? result message) (and (string? result) (string-prefix? message result)))
(define (lines file) (string-split (string-trim-right (call-with-input-file file get-string-all)) #\newline))

;; No declared steps: nothing runs and the receive goes on.
(assert (eq? (outcome (lambda () (pre-activation '(("name" . "fixture")) store))) 'passed) "absent preActivation is not a no-op")

;; A step runs with the live state root and the candidate substituted, and without the writer's environment.
(assert (eq? (outcome (lambda () (pre-activation (config (record-step "0")) store))) 'passed) "a passing step stopped the receive")
(assert (equal? (lines seen) (list "--root" state "--exit" "0" (string-append store "/x") "absent"))
        "step arguments or environment differ")
(delete-file seen)

;; The step's output and errors reach the run log, redacted.
(assert (string-contains shown "carried GITHUB_TOKEN=[redacted]") "step output was not shown redacted")
(assert (string-contains shown "Authorization: [redacted] [redacted]") "step errors were not shown redacted")
(assert (not (string-contains shown "Planted")) "a planted token reached the run log")
(assert (not (string-contains shown "planted.bearer")) "a planted bearer value reached the run log")

;; Redaction keeps ordinary words, package paths and store names, and hides credential shapes.
(for-each
  (lambda (case) (assert (equal? (redact-line (car case)) (cadr case)) (string-append "redaction differs: " (car case))))
  '(("password = hunter2; next" "password = [redacted]; next")
    ("{\"apiKey\": \"zz9\"}" "{\"apiKey\": \"[redacted]\"}")
    ("aws AKIAIOSFODNN7EXAMPLE" "aws [redacted]")
    ("slack xoxb-123-abc" "slack [redacted]")
    ("commit 6eb3082f93129173be7644a0a0399a3e9ae2be2c" "commit [redacted]")
    ("x QmFzZTY0U2VjcmV0VmFsdWVXaXRoMTIzNDU2Nzg5 y" "x [redacted] y")
    ("monkey business keyboard" "monkey business keyboard")
    ("node_modules/@red-cup-engineering/computer-content-engineering-services-section"
     "node_modules/@red-cup-engineering/computer-content-engineering-services-section")
    ("/gnu/store/gky5abcdefghijklmnpqrsvwxyz0123-cold-red-gate" "/gnu/store/gky5abcdefghijklmnpqrsvwxyz0123-cold-red-gate")))

;; Shown output is capped, with the remainder counted.
(let ((errors (open-output-string)))
  (parameterize ((current-error-port errors))
    (assert (eqv? (show-redacted 3 "seq" "10") 0) "a shown command's exit was lost"))
  (assert (equal? (get-output-string errors) "1\n2\n3\n[7 more lines not shown]\n") "shown output was not capped"))
;; A shown command that is stopped reports no success.
(parameterize ((current-error-port (open-output-string)))
  (assert (not (eqv? (show-redacted 3 "timeout" "1" "sleep" "5") 0)) "a stopped command read as success"))

;; A step that declares the kind it reports must print a JSON line of that kind: one that exits 0 having
;; printed nothing (as a script whose command body never ran) or another kind stops the receive.
(define (report-step . line)
  `(("program" . "steps/report.sh") ("arguments" . ,(list->vector line)) ("expect" . "located-index-carry.v1")))
(assert (stopped? (outcome (lambda () (pre-activation (config (report-step)) store)))
                  "pre-activation step did not report its expected kind")
        "a silent step passed although it declares what it reports")
(assert (stopped? (outcome (lambda () (pre-activation (config (report-step "{\"kind\":\"other.v1\"}")) store)))
                  "pre-activation step did not report its expected kind")
        "a step reporting another kind passed")
(assert (stopped? (outcome (lambda () (pre-activation (config (report-step "carried located-index-carry.v1")) store)))
                  "pre-activation step did not report its expected kind")
        "a step naming the kind outside a JSON line passed")
(assert (eq? (outcome (lambda () (pre-activation
                (config (report-step "{\"kind\":\"located-index-carry.v1\",\"stores\":[],\"notCarried\":0}")) store)))
             'passed)
        "a step reporting its expected kind was refused")
(assert (string-contains shown "located-index-carry.v1") "the expected report was not shown")
;; A step that declares nothing is judged by its exit alone, as before.
(assert (eq? (outcome (lambda () (pre-activation
                (config `(("program" . "steps/report.sh") ("arguments" . #()))) store)))
             'passed)
        "a step without expect was held to a report")

;; The candidate's top-level entries are links into the admitted runtime (guix-deployment.scm). A step's
;; program runs by its real path, so a script comparing argv[1] with import.meta.url finds itself.
(define admitted (string-append root "/admitted-runtime"))
(mkdir-p (string-append admitted "/scripts"))
(write-text (string-append admitted "/scripts/whoami.sh")
  "if [ \"$0\" = \"$(readlink -f \"$0\")\" ]; then echo 'ran by its real path'; else echo 'ran by a linked path'; fi\n")
(symlink admitted (string-append store "/packages"))
(assert (eq? (outcome (lambda () (pre-activation (config `(("program" . "packages/scripts/whoami.sh"))) store))) 'passed)
        "a step reached through a linked entry did not run")
(assert (string-contains shown "ran by its real path") "a step reached through a linked entry did not run by its real path")

;; The live-check journal: a wedged journalctl that has printed a token is stopped within its bound, the
;; token never shown, and the call never raises.
(define fake-path (string-append root "/fake-bin"))
(mkdir-p fake-path)
(write-text (string-append fake-path "/journalctl")
  "#!/bin/sh\necho 'unit started GITHUB_TOKEN=ghp_PlantedJournalToken0123'\necho 'Authorization: Bearer planted.journal'\nexec sleep 60\n")
(chmod (string-append fake-path "/journalctl") #o755)
(let ((path (getenv "PATH")) (errors (open-output-string)) (started (current-time)))
  (setenv "PATH" (string-append fake-path ":" path))
  (set! journal-seconds 2)
  (parameterize ((current-error-port errors)) (show-unit-journal '(("unit" . "fixture.service")) "fixture.service"))
  (set! journal-seconds 30)
  (setenv "PATH" path)
  (let ((text (get-output-string errors)))
    (assert (< (- (current-time) started) 10) "a wedged journal was not stopped within its bound")
    (assert (string-contains text "--- fixture.service before recovery ---") "journal start marker absent")
    (assert (string-contains text "unit started GITHUB_TOKEN=[redacted]") "journal was not shown redacted")
    (assert (string-contains text "--- end fixture.service ---") "journal end marker absent")
    (assert (not (string-contains text "Planted")) "a planted journal token reached the run log")
    (assert (not (string-contains text "planted.journal")) "a planted journal bearer value reached the run log")))

;; A failing step stops the receive.
(assert (stopped? (outcome (lambda () (pre-activation (config (record-step "3")) store))) "pre-activation step failed")
        "a failing step did not stop the receive")
(delete-file seen)

;; A step that outruns its budget is stopped, and stops the receive.
(let ((started (current-time)))
  (assert (stopped? (outcome (lambda () (pre-activation (config `(("program" . "steps/sleep.sh") ("timeoutSeconds" . 1))) store)))
                  "pre-activation step failed")
          "a step past its budget did not stop the receive")
  (assert (< (- (current-time) started) 4) "a step past its budget was not stopped"))

;; A program the candidate lacks stops the receive before anything runs.
(assert (stopped? (outcome (lambda () (pre-activation (config `(("program" . "steps/absent.sh"))) store)))
                "pre-activation program is not in the candidate")
        "a missing program did not stop the receive")

;; Free space: a store's source counts beyond what its carried sibling holds; a finished carry needs none.
(define index (string-append state "/a/b/index/causal-admission"))
(mkdir-p (string-append index "/v2"))
(write-bytes (string-append index "/v2/admitted.jsonl") 100000)
(let ((needed (parameterize ((current-error-port (open-output-string)))
                (carried-bytes state "index/causal-admission/v2" "index/causal-admission/v3"))))
  (assert (>= needed 100000) "uncarried source bytes were not counted"))
(mkdir-p (string-append index "/v3"))
(write-bytes (string-append index "/v3/admitted.jsonl") 200000)
(assert (= (parameterize ((current-error-port (open-output-string)))
             (carried-bytes state "index/causal-admission/v2" "index/causal-admission/v3")) 0)
        "a finished carry still counted its source")
(delete-file (string-append index "/v3/admitted.jsonl"))
;; More than the disk holds: the step never runs.
(assert (stopped? (outcome (lambda () (pre-activation
                  (config (record-step "0" `("freeSpace" . (("root" . "{stateRoot}") ("carries" . "index/causal-admission/v2")
                                                           ("into" . "index/causal-admission/v3")
                                                           ("marginBytes" . ,(expt 2 62))))))
                  store)))
                "pre-activation step lacks the free space it declares")
        "a step short of disk was not refused")
(assert (not (file-exists? seen)) "a step short of disk still ran")
(assert (eq? (outcome (lambda () (pre-activation
                  (config (record-step "0" `("freeSpace" . (("root" . "{stateRoot}") ("carries" . "index/causal-admission/v2")
                                                           ("into" . "index/causal-admission/v3")))))
                  store)))
             'passed)
        "a step with the disk it needs was refused")
(assert (file-exists? seen) "a step with the disk it needs did not run")

(define (remove-fixture path)
  (if (eq? (stat:type (lstat path)) 'directory)
    (begin (for-each (lambda (name) (unless (member name '("." ".."))
                       (remove-fixture (string-append path "/" name)))) (scandir path))
           (rmdir path))
    (delete-file path)))
(remove-fixture root)
(display "Pre-activation steps run against live state before the switch and stop it on failure.\n")
