//go:build unix

package update

import (
	"fmt"
	"syscall"
)

func freeDiskBytes(directory string) (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(directory, &stat); err != nil {
		return 0, fmt.Errorf("measure free space under %s: %w", directory, err)
	}
	return int64(stat.Bavail) * int64(stat.Bsize), nil
}
