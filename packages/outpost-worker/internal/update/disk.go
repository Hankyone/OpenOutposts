package update

import "fmt"

// diskHeadroomFactor covers the worst shape of an update: the installed
// binary, the patch intermediate, and the finished copy all on disk at once,
// plus the renamed .old the swap keeps until the new binary registers.
const diskHeadroomFactor = 3

// checkDiskSpace refuses an update that would fill the disk. Where free space
// cannot be measured the check is skipped: a missing statfs is not a reason to
// stop updating.
func (u *Updater) checkDiskSpace(directory string, size int64) error {
	free, err := freeDiskBytes(directory)
	if err != nil {
		u.log.Debug("skipping the disk-space preflight", "error", err)
		return nil
	}
	needed := size * diskHeadroomFactor
	if free < needed {
		return fmt.Errorf(
			"update needs about %d bytes free under %s; %d are available",
			needed, directory, free,
		)
	}
	return nil
}
