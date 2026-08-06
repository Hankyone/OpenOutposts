// Package lease tracks the execution leases a worker currently holds. The
// control plane is the source of truth; this store only mirrors leases the
// worker has accepted on its current connection.
package lease

import (
	"sync"
	"time"
)

type Lease struct {
	ID               string
	ProductSessionID string
	WorkspacePath    string
	WorkspaceRoot    string
	ExpiresAt        time.Time
}

type Store struct {
	mu     sync.Mutex
	leases map[string]Lease
}

func NewStore() *Store {
	return &Store{leases: make(map[string]Lease)}
}

func (s *Store) Add(l Lease) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases[l.ID] = l
}

// Get returns the lease and whether it exists. An expired lease is still
// returned so callers can distinguish lease_expired from lease_unknown.
func (s *Store) Get(id string) (Lease, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leases[id]
	return l, ok
}

// Count is how many leases this worker currently holds. Zero is one half of
// the idleness the self-updater waits for before replacing the binary.
func (s *Store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.leases)
}

func (s *Store) Remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.leases, id)
}

// Clear drops every lease. Called when a connection ends: the control plane
// re-offers active leases after the next registration.
func (s *Store) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases = make(map[string]Lease)
}
