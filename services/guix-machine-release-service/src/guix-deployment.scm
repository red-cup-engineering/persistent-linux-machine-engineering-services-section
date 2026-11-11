;;; A deployed application is its admitted JS closure and a pinned interpreter.
;;; npm's lockfile remains the dependency authority; no parallel Guix registry.
(define-module (guix-deployment)
  #:use-module (guix packages)
  #:use-module (guix download)
  #:use-module (guix store)
  #:use-module (guix derivations)
  #:use-module ((guix grafts) #:select (%graft?))
  #:use-module (gnu packages base)
  #:use-module (gnu packages compression)
  #:use-module ((gnu packages guile) #:select (guile-3.0.11 guile-json-4))
  #:use-module (guix gexp)
  #:use-module (guix build-system trivial)
  #:use-module (gnu packages node)
  #:use-module ((gnu packages pdf) #:select (poppler-next))
  #:use-module (gnu packages bash)
  #:use-module (gnu packages ssh)
  #:use-module (ice-9 format)
  #:use-module (srfi srfi-1)
  #:export (node-runtime-release enterprise-deployment dependency-toolchain one-time-custody-tool))

;; A separately authenticated, disposable conversion source is a controller
;; input. It is never a provider in the common software dependency graph.
(define custody-tool-receiver
  ;; Guix module loading can evaluate this declaration without current-filename.
  ;; Resolve the selected module's source through the same admitted load path.
  (let ((source (or (current-filename) (search-path %load-path "guix-deployment.scm")
                    (error "selected Guix deployment source is unavailable"))))
    (local-file (string-append (dirname source) "/../scripts/realize-custody-tool.mjs"))))
(define* (one-time-custody-tool directory #:key (original-artifacts '()))
  (unless (and (string? directory) (file-exists? (string-append directory "/source.json")))
    (error "one-time custody tool requires authenticated source realization"))
  (unless (and (pair? original-artifacts) (<= (length original-artifacts) 4)
               (every string? original-artifacts))
    (error "one-time tool requires finite exact original immutable artifacts"))
  (let ((originals (map runtime-release-input original-artifacts)))
  (package
    (name "one-time-custody-tool") (version "1") (source #f)
    (build-system trivial-build-system)
    (arguments
      (list #:modules '((guix build utils))
        #:builder #~(begin
          (use-modules (guix build utils))
          (copy-recursively #$(local-file directory "one-time-custody-source" #:recursive? #t) #$output)
          (invoke #$(file-append node "/bin/node") #$custody-tool-receiver "verify" #$output)
          (chmod #$output #o755)
          (mkdir-p (string-append #$output "/original-inputs"))
          (let loop ((inputs '#$(map (lambda (item) (file-append item "")) originals)) (index 0))
            (unless (null? inputs)
              (symlink (car inputs) (string-append #$output "/original-inputs/" (number->string index)))
              (loop (cdr inputs) (+ index 1)))))))
    (home-page "https://561.group")
    (synopsis "Exact branch-only source for one leased semantic conversion")
    (description "Authenticated one-time controller input; no legacy runtime reader is admitted.")
    (license #f))))

;; Software is realized once. Instance units bind identity, state and secrets to
;; this same store output; they do not assemble independent application graphs.
(define (node-runtime-release name version directory)
  (unless (and (string? directory) (file-exists? directory))
    (error "node-runtime-release requires a fabricated pnpm runtime closure"))
  (package
    (name name)
    (version version)
    (source #f)
    (build-system trivial-build-system)
    (arguments
      (list
        #:guile guile-3.0.11
        #:modules '((guix build utils))
        #:builder
        #~(begin
            (use-modules (guix build utils))
            (mkdir-p (string-append #$output "/share"))
            (mkdir-p (string-append #$output "/bin"))
            (symlink #$(local-file directory "pnpm-runtime" #:recursive? #t)
                     (string-append #$output "/share/runtime"))
            (symlink #$(file-append node "/bin/node")
                     (string-append #$output "/bin/node"))
            ;; Certified weather methodology consumes the existing Poppler CLI.
            ;; This programme is a native input of the one common software
            ;; output, never a laptop/host PATH prerequisite or a new decoder.
            (let ((programme #$(file-append poppler-next "/bin/pdftotext")))
              (unless (file-exists? programme)
                (error "shared native PDF extractor is unavailable"))
              (symlink programme (string-append #$output "/bin/pdftotext"))))))
    (home-page "https://561.group")
    (synopsis "One immutable Node software closure for all receiving instances")
    (description "The already fabricated pnpm runtime, Guix Node interpreter and native Poppler PDF extraction programme. Instance bindings reuse this identical software output without source inventories or per-machine dependency resolution.")
    (license #f)))

;; Independent, fixed tooling inputs. The machine lock remains the application
;; dependency authority. No package-manager bootstrap or lifecycle executes here.
(define pnpm-tool-source
  (origin
    (method url-fetch)
    (uri "https://registry.npmjs.org/pnpm/-/pnpm-10.34.6.tgz")
    (sha256 #vu8(68 215 219 144 252 187 35 21 181 129 248 89 137 169 19 70 103 101 66 31 198 86 194 142 128 250 193 183 171 91 228 86))))
(define yaml-tool-source
  (origin
    (method url-fetch)
    (uri "https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz")
    (sha256 #vu8(0 143 162 4 203 27 167 0 224 39 43 160 69 171 191 9 166 255 230 52 86 232 20 107 169 124 172 108 42 209 239 145))))

(define (dependency-toolchain)
  ;; Computing grafts can itself build a missing output. Refuse that context
  ;; before deriving any prerequisite; callers already use --no-grafts.
  (when (%graft?)
    (error "dependency toolchain requires the reviewed ungrafted context"))
  ;; Use the channel's exact canonical build tools, as Guix does for its
  ;; standard patch inputs. The top-level packages are different derivations
  ;; from the bootstrap-final variants already used by GNU builds. Bind them
  ;; once so the prerequisite guard and archive builder use identical inputs.
  (let ((tar (canonical-package tar))
        (gzip (canonical-package gzip))
        ;; The pinned Guix self-build uses this package, while default-guile
        ;; is a distinct bootstrap-final 3.0.9. Require the exact output and
        ;; pass the same package to the supported trivial-builder override.
        (builder-guile guile-3.0.11))
    ;; Reuse existing runtime/build tools. In particular, building a missing
    ;; stock Node would run its upstream JS suite, including SQLite tests.
    (with-store store
      (for-each
        (lambda (prerequisite)
          (let ((path (derivation->output-path
                        (package-derivation store prerequisite #:graft? #f))))
            (unless (valid-path? store path)
              (error "dependency toolchain prerequisite is not already realized"
                     (package-name prerequisite) path))))
        (list node tar gzip builder-guile)))
    (package
      (name "machine-dependency-toolchain")
      (version "10.34.6-yaml-2.9.0")
      (source #f)
      (build-system trivial-build-system)
      (arguments
        (list
          #:guile builder-guile
          #:modules '((guix build utils))
          #:builder
          #~(begin
            (use-modules (guix build utils))
            (let* ((out #$output)
                   (pnpm (string-append out "/share/pnpm"))
                   (yaml (string-append out "/share/yaml"))
                   (archives (string-append out "/share/archives")))
              (mkdir-p pnpm) (mkdir-p yaml) (mkdir-p archives)
              (mkdir-p (string-append out "/bin"))
              (invoke #$(file-append tar "/bin/tar")
                      "--use-compress-program" #$(file-append gzip "/bin/gzip")
                      "-xf" #$pnpm-tool-source "-C" pnpm)
              (invoke #$(file-append tar "/bin/tar")
                      "--use-compress-program" #$(file-append gzip "/bin/gzip")
                      "-xf" #$yaml-tool-source "-C" yaml)
              ;; Preserve archive identity for the fixed synthetic receiving assay.
              (symlink #$pnpm-tool-source (string-append archives "/pnpm-10.34.6.tgz"))
              (symlink #$yaml-tool-source (string-append archives "/yaml-2.9.0.tgz"))
              (symlink #$(file-append node "/bin/node") (string-append out "/bin/node"))))))
      (home-page "https://561.group")
      (synopsis "Pinned dependency acquisition tooling for machine releases")
      (description "The inspected pnpm and YAML archives with the machine's pinned Node interpreter. Their code is not executed during realization. Application dependencies remain governed by the reviewed npm lock.")
      (license #f))))

;; A successful node-runtime-release build may be reused by its exact realized
;; store output. Guix's existing parameterized file-like adapter retains that
;; store item as an input; raw strings are not valid file-append bases.
(define (runtime-release-input value)
  (if (string? value)
      (let ((store (canonicalize-path value)))
        (unless (and (string=? value store)
                     (string=? (dirname store) "/gnu/store")
                     (file-is-directory? store))
          (error "runtime release must be a canonical immutable store output"))
        (with-store connection
          (unless (valid-path? connection store)
            (error "runtime release is not a registered realized Guix input" store)))
        (with-parameters () store))
      value))

;; Receiving policy is finite JSON data owned by the authenticated Scheme
;; target. It cannot declare software, override derived units or rename identity.
(define receiving-policy-fields
  '("releaseRoot" "receiptRoot" "stateRoot" "health" "retiredDeployers"
    "auxiliaryChecks" "gcRoot" "guixProfile" "configurationFiles"
    "restartAuxiliaryUnits" "mediaReceipt" "custodyTransition"
    "retiredConfigurationFiles" "supervisor" "supervisorSocket" "retainedReleases"))
(define (receiving-json? value depth)
  (and (< depth 32)
    (or (string? value) (boolean? value) (integer? value)
      (and (vector? value)
           (every (lambda (item) (receiving-json? item (+ depth 1)))
                  (vector->list value)))
      (and (list? value) (pair? value)
           (every (lambda (pair)
                    (and (pair? pair) (string? (car pair))
                         (receiving-json? (cdr pair) (+ depth 1)))) value)
           (= (length value) (length (delete-duplicates (map car value))))))))
(define (validate-retained-releases records)
  (unless (and (vector? records) (> (vector-length records) 0)
    (= (vector-length records)
       (length (delete-duplicates (map (lambda (record) (assoc-ref record "storePath")) (vector->list records))))))
    (error "retained releases must be distinct exact store outputs"))
  (for-each
    (lambda (record)
      (unless (and (list? record)
        (equal? (sort (map car record) string<?)
          (sort '("storePath" "repository" "revision" "repositoryId" "repositoryNodeId" "transferredTo"
                  "sourceReceiptSha256" "files" "entry" "host" "instance") string<?))
        (every (lambda (key) (let ((value (assoc-ref record key))) (and (string? value) (> (string-length value) 0))))
               '("storePath" "repository" "revision" "repositoryNodeId" "transferredTo" "sourceReceiptSha256" "entry" "host" "instance"))
        (string-match "^/gnu/store/[^/]+$" (assoc-ref record "storePath"))
        (string-match "^[0-9a-f]{40}$" (assoc-ref record "revision"))
        (string-match "^[0-9a-f]{64}$" (assoc-ref record "sourceReceiptSha256"))
        (integer? (assoc-ref record "repositoryId")) (> (assoc-ref record "repositoryId") 0)
        (vector? (assoc-ref record "files")) (> (vector-length (assoc-ref record "files")) 0)
        (every (lambda (file)
          (and (list? file) (equal? (sort (map car file) string<?) '("path" "sha256"))
               (string? (assoc-ref file "path")) (string? (assoc-ref file "sha256"))
               (string-match "^[0-9a-f]{64}$" (assoc-ref file "sha256"))))
          (vector->list (assoc-ref record "files"))))
        (error "retained release requires a closed original receiving record")))
    (vector->list records)))
(define (validate-receiving-policy policy)
  (unless (and (receiving-json? policy 0)
               (every (lambda (pair) (member (car pair) receiving-policy-fields)) policy))
    (error "receiving policy must contain only native target receiving fields"))
  (for-each (lambda (key)
              (unless (and (string? (assoc-ref policy key))
                           (> (string-length (assoc-ref policy key)) 0))
                (error "native receiving policy lacks required field" key)))
            '("releaseRoot" "receiptRoot" "stateRoot" "health" "gcRoot" "guixProfile"))
  (when (assoc-ref policy "retainedReleases")
    (validate-retained-releases (assoc-ref policy "retainedReleases"))))

;; Units and launchers are built with their actual store paths. The host's
;; systemd remains responsible for sockets, cgroups and process supervision.
(define* (enterprise-deployment machine-name directory entry
                               #:key runtime-release receiver-envelope custody-tool receiving-policy environment-file (environment '())
                               socket (heap 512) (restart-seconds 5)
                               oom-score memory-high (auxiliary-units '()) (commands '()) reverse-tunnel
                               (requires '()))
  (let ((admitted-source (getenv "GUIX_DEPLOYMENT_SOURCE"))
        (runtime-release (runtime-release-input runtime-release)))
    (when custody-tool
      (unless (and receiver-envelope (package? custody-tool))
        (error "custody tool must be a separate authenticated controller derivation")))
    (when receiver-envelope
      (validate-receiving-policy receiving-policy)
      (unless (string? environment-file)
        (error "native receiving requires its declared environment file"))
      (when (and (assoc-ref receiving-policy "custodyTransition") (not custody-tool))
        (error "semantic custody policy requires its separate exact tool input"))
      (unless (and runtime-release (string? receiver-envelope)
                   (file-exists? receiver-envelope))
        (error "receiver envelope requires the shared immutable runtime release")))
    (unless (or runtime-release (and admitted-source (file-exists? admitted-source)))
      (error "GUIX_DEPLOYMENT_SOURCE must name the admitted runtime closure"))
    (package
      (name (string-append machine-name "-deployment"))
      (version "1")
      (source #f)
      (build-system trivial-build-system)
      (arguments
       (list
        #:modules '((guix build utils) (ice-9 format) (ice-9 regex) (ice-9 ftw) (srfi srfi-1))
        #:builder
        (with-extensions (list guile-json-4)
        #~(begin
            (use-modules (guix build utils) (ice-9 format) (ice-9 regex) (ice-9 ftw) (srfi srfi-1) (json))
            (let* ((out #$output)
                   (runtime #$(file-append (or runtime-release node) "/bin/node"))
                   (bin (string-append out "/bin"))
                   (units (string-append out "/.guix-systemd"))
                   (launcher (string-append bin "/" #$machine-name))
                   (unit (string-append units "/" #$machine-name "-561-group.service"))
                   (env
                    (map (lambda (pair)
                           (cons (car pair)
                                 (regexp-substitute/global
                                  #f "\\{release\\}" (cdr pair) 'pre out 'post)))
                         (append '#$environment
                           (list (cons "NODE_OPTIONS" (format #f "--max-old-space-size=~a --disable-sigusr1" #$heap))
                                 (cons "PATH" (string-append out "/bin:/home/emsenn/.local/bin:/usr/local/bin:/usr/bin:/bin")))))))
              ;; The admitted tree is already an immutable Guix input. Retain it
              ;; in the output's closure without copying the entire tree twice.
              (mkdir-p out)
              (let ((tree #$(if runtime-release
                               (file-append runtime-release "/share/runtime")
                               (local-file admitted-source "admitted-runtime" #:recursive? #t))))
                ;; A target envelope is a separate immutable input. It cannot
                ;; replace code, package links or any other shared entry.
                (when #$receiver-envelope
                  (when (file-exists? (string-append tree "/.software"))
                    (error "shared software reserves the receiver binding entry")))
                (for-each (lambda (file)
                            (unless (member file '("." ".."))
                              (symlink (string-append tree "/" file) (string-append out "/" file))))
                          (scandir tree)))
              #$(if receiver-envelope
                    #~(let ((envelope #$(local-file receiver-envelope "receiver-envelope" #:recursive? #t)))
                        (for-each
                          (lambda (entry)
                            (unless (and (file-is-directory? (string-append envelope "/" entry))
                                         (not (eq? 'symlink (stat:type (lstat (string-append envelope "/" entry))))))
                              (error "receiver envelope lacks its direct required entry" entry)))
                          '(".metadata" ".controller" "deployment"))
                        (for-each
                          (lambda (file)
                            (unless (member file '("." ".."))
                              (when (or (member file '(".software" ".custody-tool" "node_modules" "packages" "package.json" "bin" ".guix-systemd" ".guix-shepherd"))
                                        (false-if-exception (lstat (string-append out "/" file))))
                                (error "receiver envelope overlaps shared software" file))))
                          (scandir envelope))
                        (for-each
                          (lambda (file)
                            (unless (member file '("." ".."))
                              (if (string=? file ".controller")
                                  (copy-recursively (string-append envelope "/" file)
                                                    (string-append out "/" file))
                                  (symlink (string-append envelope "/" file) (string-append out "/" file)))))
                          (scandir envelope))
                        ;; This reference is generated from the very package
                        ;; supplying the shared tree, never a metadata override.
                        (symlink #$runtime-release (string-append out "/.software")))
                    #~#t)
              (when #$custody-tool
                (when (file-exists? (string-append out "/.custody-tool"))
                  (error "common software cannot supply a one-time custody tool"))
                (symlink #$custody-tool (string-append out "/.custody-tool")))
              (mkdir-p bin)
              (mkdir-p units)
              ;; Generate controller data from this actual declaration. The
              ;; envelope has source/authentication carriers, never an authored
              ;; machine manifest or another package/entry selection.
              (when #$receiver-envelope
                (let* ((file (string-append out "/.controller/machine.json"))
                       (release (call-with-input-file
                                  (string-append out "/.metadata/release.json") json->scm))
                       (auxiliary (append
                         (append-map (lambda (service)
                           (let ((timer (assoc-ref service 'timer)))
                             (append (list (assoc-ref service 'name))
                               (if timer (list (assoc-ref timer 'name)) '()))))
                           '#$auxiliary-units)
                         (if '#$reverse-tunnel (list (string-append #$machine-name "-ingress.service")) '())))
                       (config (append '#$receiving-policy
                         (list (cons "name" #$machine-name)
                           (cons "repository" (assoc-ref release "machineRepository"))
                           (cons "unit" (string-append #$machine-name "-561-group.service"))
                           (cons "environmentFile" #$environment-file)
                           (cons "environment" env)
                           (cons "auxiliaryUnits" (list->vector auxiliary))
                           (cons "stateCompatibility" "preserve-existing")))))
                  (when (file-exists? file)
                    (error "authored machine manifests cannot supply native receiving policy"))
                  (call-with-output-file file (lambda (port) (scm->json config port) (newline port)))
                  (invoke runtime (string-append out "/.controller/scripts/release-storage.mjs")
                          "--fabricate" out)))
              (when (file-exists? (string-append out "/.storage-systemd"))
                (for-each
                  (lambda (file)
                    (unless (member file '("." ".."))
                      (copy-file (string-append out "/.storage-systemd/" file) (string-append units "/" file))
                      (substitute* (string-append units "/" file) (("/RELEASE") out))))
                  (scandir (string-append out "/.storage-systemd"))))
              (symlink runtime (string-append bin "/node"))
              (when #$runtime-release
                (let ((programme #$(and runtime-release (file-append runtime-release "/bin/pdftotext"))))
                  (unless (file-exists? programme)
                    (error "target requires the received common native PDF extractor"))
                  (symlink programme (string-append bin "/pdftotext"))))
              (call-with-output-file launcher
                (lambda (port)
                  (format port "#!~a~%export PATH=~s:\"${PATH:-}\"~%exec ~s ~s \"$@\"~%"
                          #$(file-append bash-minimal "/bin/sh")
                          (string-append out "/bin")
                          runtime (string-append out "/" #$entry))))
              (chmod launcher #o555)
              (for-each
                (lambda (command)
                  (let ((path (string-append bin "/" (assoc-ref command 'name)))
                        (program (string-append out "/" (assoc-ref command 'program))))
                    (unless (file-exists? program) (error "operator program missing" program))
                    (call-with-output-file path
                      (lambda (port)
                        (format port "#!~a~%export PATH=~s:\"${PATH:-}\"~%exec ~s ~s \"$@\"~%"
                                #$(file-append bash-minimal "/bin/sh")
                                (string-append out "/bin") runtime program)))
                    (chmod path #o555)))
                '#$commands)
              (call-with-output-file (string-append bin "/owning-repository-release-only")
                (lambda (port)
                  (format port "#!~a~%echo 'Release through reviewed owning-repository merges and the GitHub Guix machine snapshot.' >&2~%exit 1~%"
                          #$(file-append bash-minimal "/bin/sh"))))
              (chmod (string-append bin "/owning-repository-release-only") #o555)
              (call-with-output-file unit
                (lambda (port)
                  ;; Units the service cannot start without (its rendered credentials, say)
                  ;; run first, and again whenever the service starts.
                  (format port "[Unit]~%Description=~a Guix enterprise deployment~%After=network-online.target~a~%Wants=network-online.target~a~%~a~%[Service]~%Type=simple~%WorkingDirectory=~a/~a~%ExecStart=~a~%EnvironmentFile=~a~%"
                          #$machine-name
                          (string-append (if #$socket (string-append " " #$socket) "")
                            (apply string-append (map (lambda (u) (string-append " " u)) '#$requires)))
                          (string-append (if #$socket (string-append " " #$socket) "")
                            (if '#$reverse-tunnel (string-append " " #$machine-name "-ingress.service") ""))
                          (string-append
                            (if (null? '#$requires) ""
                                (string-append "Requires=" (string-join '#$requires " ") "\n"))
                            (if (file-exists? (string-append out "/.storage-systemd"))
                                (string-append "Wants=" #$machine-name "-storage.timer\n") ""))
                          out #$directory launcher #$environment-file)
                  (format port "EnvironmentFile=~a/environment~%" units)
                  (format port "Environment=\"PATH=~a/bin:/home/emsenn/.local/bin:/usr/local/bin:/usr/bin:/bin\"~%" out)
                  (format port "Environment=\"NODE_OPTIONS=--max-old-space-size=~a --disable-sigusr1\"~%" #$heap)
                  (when #$oom-score (format port "OOMScoreAdjust=~a~%" #$oom-score))
                  (when #$memory-high (format port "MemoryHigh=~a~%" #$memory-high))
                  (format port "Restart=on-failure~%RestartSec=~a~%TimeoutStartSec=600~%UMask=0077~%~%[Install]~%WantedBy=default.target~%" #$restart-seconds)))
              (call-with-output-file (string-append units "/environment")
                (lambda (port)
                  (for-each (lambda (pair) (format port "~a=~s~%" (car pair) (cdr pair))) env)))
              ;; The same generation for a machine whose supervisor is GNU Shepherd (a container whose
              ;; PID 1 is not systemd): one service file that `herd load` registers. It reads the same
              ;; environment files as the systemd units, afresh at every start, a later file winning as
              ;; with EnvironmentFile. Simple auxiliary services are its services too; oneshot and timed
              ;; ones are not realized under Shepherd, and its receiver refuses a machine declaring them.
              (let ((shepherd (string-append out "/.guix-shepherd"))
                    (forkexec
                      (lambda (name command directory files respawn-delay)
                        `(service '(,(string->symbol name))
                           #:documentation ,(string-append name " Guix deployment")
                           #:start (lambda _
                                     ((make-forkexec-constructor ',command
                                        #:directory ,directory
                                        #:environment-variables (environment-of ',files)
                                        #:file-creation-mask #o077)))
                           #:stop (make-kill-destructor)
                           #:respawn? #t
                           #:respawn-delay ,respawn-delay))))
                (mkdir-p shepherd)
                (call-with-output-file (string-append shepherd "/" #$machine-name "-561-group.scm")
                  (lambda (port)
                    (for-each
                      (lambda (form) (write form port) (newline port))
                      `((use-modules (shepherd service) (ice-9 rdelim) (srfi srfi-1))
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
                        (register-services
                          (list
                            ,(forkexec (string-append #$machine-name "-561-group") (list launcher)
                                       (string-append out "/" #$directory)
                                       (filter string? (list #$environment-file (string-append units "/environment")))
                                       #$restart-seconds)
                            ,@(filter-map
                                (lambda (service)
                                  (and (equal? (assoc-ref service 'type) "simple")
                                       (not (assoc-ref service 'timer))
                                       (let ((name (assoc-ref service 'name)))
                                         (forkexec (if (string-suffix? ".service" name) (string-drop-right name 8) name)
                                                   (list (if (assoc-ref service 'shell?) #$(file-append bash-minimal "/bin/bash") runtime)
                                                         (string-append out "/" (assoc-ref service 'program)))
                                                   (string-append out "/" (assoc-ref service 'directory))
                                                   (append (or (assoc-ref service 'environment-files) '())
                                                           (list (string-append units "/" name ".environment")))
                                                   5))))
                                '#$auxiliary-units))))))))
              (when '#$reverse-tunnel
                (call-with-output-file (string-append units "/" #$machine-name "-ingress.service")
                  (lambda (port)
                    (format port "[Unit]~%Description=~a private ingress transport~%After=network-online.target~%[Service]~%Type=simple~%ExecStart=~a -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R ~a ~a~%Restart=always~%RestartSec=5~%UMask=0077~%"
                      #$machine-name #$(file-append openssh "/bin/ssh")
                      (cadr '#$reverse-tunnel) (car '#$reverse-tunnel)))))
              ;; Additional services belong to the same immutable generation
              ;; and are installed by the same release transaction.
              (for-each
                (lambda (service)
                  (let* ((name (assoc-ref service 'name))
                         (program (assoc-ref service 'program))
                         (command (string-append out "/" program))
                         (interpreter (if (assoc-ref service 'shell?)
                                          #$(file-append bash-minimal "/bin/bash") runtime)))
                    (unless (file-exists? command) (error "auxiliary program missing" name program))
                    (call-with-output-file (string-append units "/" name)
                      (lambda (port)
                        (format port "[Unit]~%Description=~a Guix deployment~%After=network-online.target~a~%~a[Service]~%Type=~a~%WorkingDirectory=~a/~a~%ExecStart=~a ~a~%TimeoutStartSec=~a~%UMask=0077~%"
                                name (if (assoc-ref service 'after) (string-append " " (assoc-ref service 'after)) "")
                                (if (assoc-ref service 'requires) (string-append "Requires=" (assoc-ref service 'requires) "\n") "")
                                (if (equal? (assoc-ref service 'type) "simple") "simple" "oneshot")
                                out (assoc-ref service 'directory) interpreter command
                                (or (assoc-ref service 'timeout) "3600"))
                        (when (equal? (assoc-ref service 'type) "simple")
                          (format port "Restart=on-failure~%RestartSec=5~%"))
                        (when (assoc-ref service 'precheck)
                          (format port "ExecStartPre=~a ~a/~a~%" runtime out (assoc-ref service 'precheck)))
                        (when (assoc-ref service 'poststop)
                          (format port "ExecStopPost=~a ~a/~a~%" runtime out (assoc-ref service 'poststop)))
                        (when (assoc-ref service 'memory-high)
                          (format port "MemoryHigh=~a~%" (assoc-ref service 'memory-high)))
                        (when (assoc-ref service 'nice)
                          (format port "Nice=~a~%" (assoc-ref service 'nice)))
                        (for-each (lambda (file) (format port "EnvironmentFile=~a~%" file))
                                  (or (assoc-ref service 'environment-files) '()))
                        (format port "EnvironmentFile=~a/~a.environment~%" units name)))
                    (call-with-output-file (string-append units "/" name ".environment")
                      (lambda (port)
                        (for-each
                          (lambda (pair)
                            (format port "~a=~s~%" (car pair)
                                    (regexp-substitute/global #f "\\{release\\}" (cdr pair) 'pre out 'post)))
                          (append (or (assoc-ref service 'environment) '())
                                  (list (cons "PATH" (string-append out "/bin:/home/emsenn/.local/bin:/usr/local/bin:/usr/bin:/bin")))))))
                    (when (assoc-ref service 'timer)
                      (let ((timer (assoc-ref service 'timer)))
                        (call-with-output-file (string-append units "/" (assoc-ref timer 'name))
                          (lambda (port)
                            (format port "[Unit]~%Description=~a schedule~%[Timer]~%OnBootSec=~a~%OnUnitInactiveSec=~a~%Unit=~a~%Persistent=true~%[Install]~%WantedBy=timers.target~%"
                                    name (assoc-ref timer 'boot) (assoc-ref timer 'interval) name)))))))
                '#$auxiliary-units)
              ;; Structural receiving executes inside this build, against the
              ;; actual shared interpreter and composed immutable inputs. Do not
              ;; source the operating environment or run the activation observer.
              (when #$receiver-envelope
                (invoke runtime (string-append out "/.controller/scripts/check-host.mjs")
                        out "--build-only"))
              #t)))))
      (home-page "https://561.group")
      (synopsis (string-append machine-name " enterprise deployment"))
      (description
       "An admitted application closure, its Guix interpreter, launcher and service.
Persistent state and credentials remain in the host's existing custody.")
      (license #f))))
