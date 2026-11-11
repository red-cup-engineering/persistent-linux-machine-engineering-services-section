;;; Pure source selection shared by release orchestration and its fixture test.
(use-modules (ice-9 regex) (ice-9 textual-ports) (json) (srfi srfi-1))
;; The release controller is its own repository, mounted by the machine's repository: its package is that
;; repository's root, at the commit the machine's gitlink records.
(define controller-repository-name "red-cup-engineering/guix-machine-release-service")
(define (controller-owner spec)
  (let* ((repository controller-repository-name)
         (path ".")
         (repositories (assoc-ref spec "repositories")))
    (unless (vector? repositories) (error "release controller needs the machine's sources"))
    (let ((sources (filter (lambda (source)
                             (and (list? source) (equal? (assoc-ref source "repository") repository)))
                           (vector->list repositories))))
      (unless (= (length sources) 1) (error "the machine's repository must mount the release controller exactly once"))
      (let ((commit (assoc-ref (car sources) "commit")))
        (unless (and (string? commit) (string-match "^[0-9a-f]{40}$" commit))
          (error "release controller needs an exact commit"))
        `(("repository" . ,repository) ("commit" . ,commit) ("path" . ,path))))))

;;; Recheck the newly selected commit, not only the earlier bootstrap snapshot.
(define (controller-service-directory directory path)
  (let* ((root (canonicalize-path directory))
         (service (canonicalize-path (string-append root "/" path))))
    (unless (or (equal? service root) (string-prefix? (string-append root "/") service))
      (error "release controller resolves outside its repository"))
    (let ((manifest (call-with-input-file (string-append service "/package.json") json->scm)))
      (unless (equal? (assoc-ref manifest "name") "@red-cup-engineering/guix-machine-release-service")
        (error "selected source is not the release controller package")))
    service))
