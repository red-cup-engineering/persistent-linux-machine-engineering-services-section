;;; Resolve only already-realized, exact pinned-channel interpreter inputs.
;;; Called through pinned-guix.scm --require-installed; never build or substitute.
(use-modules (guix packages) (guix store) (guix derivations) (guix grafts)
             ((gnu packages guile) #:select (guile-3.0.11 guile-json-4)) (json))
(unless (= (length (command-line)) 1)
  (error "installed controller test tools take no arguments"))
(parameterize ((%graft? #f))
  (with-store store
    (define (installed package)
      (let ((path (derivation->output-path
                    (package-derivation store package #:graft? #f))))
        (unless (valid-path? store path)
          (error "controller test prerequisite is not already realized"
                 (package-name package) path))
        path))
    ;; These are the pinned Guix self-build's interpreter and JSON module.
    (let ((guile (installed guile-3.0.11))
          (json (installed guile-json-4)))
      (scm->json `(("guile" . ,guile) ("json" . ,json)))
      (newline))))
