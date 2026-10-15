import { useEffect } from 'react';
import { UpdateService } from '../services/updateService';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';

// Hook for checking for updates automatically on application startup
export const useAutoUpdateCheck = () => {
  const { setUpdateNotification } = useAppStore(useShallow((state) => ({
    setUpdateNotification: state.setUpdateNotification,
  })));

  useEffect(() => {
    const checkUpdatesOnStartup = async () => {
      try {
        const result = await UpdateService.checkForUpdates();
        if (result.hasUpdate && result.latestVersion) {
          console.log('New version available:', result.latestVersion.number);

          // Set global update notification
          setUpdateNotification({
            version: result.latestVersion.number,
            releaseDate: result.latestVersion.releaseDate,
            changelog: result.latestVersion.changelog,
            downloadUrl: result.latestVersion.downloadUrl,
            dismissed: false,
          });
        }
      } catch (error) {
        console.error('Startup update check failed:', error);
      }
    };

    // Delay check by 3 seconds to avoid impacting application startup performance
    const timer = setTimeout(checkUpdatesOnStartup, 3000);
    return () => clearTimeout(timer);
  }, [setUpdateNotification]);
};
