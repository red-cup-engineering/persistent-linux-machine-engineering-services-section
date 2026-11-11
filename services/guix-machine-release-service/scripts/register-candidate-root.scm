(use-modules (guix store) (ice-9 match))
(match (cdr (command-line))
  ((store root)
   (unless (string-prefix? "/gnu/store/" store) (error "candidate is not a Guix store path"))
   (with-store connection
     ;; Replace the named root atomically; register its stable public pathname.
     (let ((next (string-append root ".next-" (number->string (getpid)))))
       (symlink store next) (rename-file next root)
       (add-indirect-root connection root))))
  (_ (error "usage: register-candidate-root.scm STORE PUBLIC-GC-ROOT")))
