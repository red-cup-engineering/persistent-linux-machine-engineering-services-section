;; Exercise the receiver's actual predicate without invoking a deployment.
(use-modules (ice-9 match))
(call-with-input-file
  (string-append (dirname (car (command-line))) "/../scripts/receive.scm")
  (lambda (port)
    (let loop ((form (read port)))
      (unless (eof-object? form)
        (match form
          (('define ('admitted-health-reading? . arguments) . body)
           (eval form (current-module)))
          (_ #f))
        (loop (read port))))))
(define artifact "/gnu/store/admitted-machine")
(for-each
  (lambda (case)
    (unless (equal? (admitted-health-reading? (car case) artifact) (cadr case))
      (error "health contract guard failed" case)))
  `(((("ok" . #t) ("state" . "ready") ("artifact" . ,artifact)) #t)
    ((("ok" . #t) ("state" . "degraded") ("artifact" . ,artifact)) #t)
    ((("ok" . #f) ("state" . "unready") ("artifact" . ,artifact)) #f)
    ((("ok" . #t) ("state" . "ready") ("artifact" . "/gnu/store/foreign")) #f)))
(display "Health proof and immutable identity guards passed.\n")

;; The same native gate exercises actual success/rollback with inert files and closed ports.
(primitive-load (string-append (dirname (car (command-line))) "/credential-unit-receiving.scm"))

(primitive-load (string-append (dirname (car (command-line))) "/media-dependency-observation.scm"))

(primitive-load (string-append (dirname (car (command-line))) "/pre-activation.scm"))
