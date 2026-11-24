(define-module (bootstrap-channels)
  #:use-module (guix channels)
  #:export (bootstrap-channels))

;; The host Guix cannot directly compile the production-pinned channel.  This
;; authenticated first hop supplies the interpreter for the final evaluation.
(define bootstrap-channels
  (list
   (channel
    (inherit %default-guix-channel)
    (commit "6c03bb1da2b81bb5b1ebf4e6942bee2454b5950a"))))

bootstrap-channels
