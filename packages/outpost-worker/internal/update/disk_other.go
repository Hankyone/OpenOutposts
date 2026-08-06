//go:build !unix

package update

import "errors"

func freeDiskBytes(string) (int64, error) {
	return 0, errors.New("free space cannot be measured on this platform")
}
