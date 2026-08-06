package config

import "testing"

func TestValidate(t *testing.T) {
	t.Parallel()

	valid := Config{
		ControlPlaneURL: "https://control.openoutposts.com",
		ID:              "workstation-01",
		Name:            "workstation-01",
		Token:           "secret",
		WorkspaceRoots:  []string{"/workspace"},
	}
	withChanges := func(mutate func(c *Config)) Config {
		c := valid
		c.WorkspaceRoots = append([]string(nil), valid.WorkspaceRoots...)
		mutate(&c)
		return c
	}

	tests := []struct {
		name    string
		config  Config
		wantErr bool
	}{
		{name: "valid", config: valid},
		{
			name:   "plaintext loopback allowed for local development",
			config: withChanges(func(c *Config) { c.ControlPlaneURL = "http://127.0.0.1:8788" }),
		},
		{
			name:   "plaintext localhost allowed",
			config: withChanges(func(c *Config) { c.ControlPlaneURL = "ws://localhost:8788" }),
		},
		{
			name:    "plaintext non-loopback rejected",
			config:  withChanges(func(c *Config) { c.ControlPlaneURL = "http://control.example.com" }),
			wantErr: true,
		},
		{
			name:    "missing control plane",
			config:  withChanges(func(c *Config) { c.ControlPlaneURL = "" }),
			wantErr: true,
		},
		{
			name:    "missing token",
			config:  withChanges(func(c *Config) { c.Token = "" }),
			wantErr: true,
		},
		{
			name:    "invalid ID",
			config:  withChanges(func(c *Config) { c.ID = "workstation/01" }),
			wantErr: true,
		},
		{
			name:    "invalid URL",
			config:  withChanges(func(c *Config) { c.ControlPlaneURL = "control.openoutposts.com" }),
			wantErr: true,
		},
		{
			name:    "workspace roots are required",
			config:  withChanges(func(c *Config) { c.WorkspaceRoots = nil }),
			wantErr: true,
		},
		{
			name:    "workspace roots must be absolute",
			config:  withChanges(func(c *Config) { c.WorkspaceRoots = []string{"relative/path"} }),
			wantErr: true,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := test.config.Validate(); (err != nil) != test.wantErr {
				t.Fatalf("Validate() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}
