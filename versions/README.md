# Version Management

## Directory Structure

- `version-info.xml` - XML file storing all version information
- `README.md` - This documentation file

## Version Update Process

### 1. Update Version Information

Update version information automatically using the script:

```bash
npm run update-version 0.1.3 "Fix search functionality bug" "Add new filter options" "Optimize UI responsiveness"
```

This command will:
- Update the version number in `package.json`
- Append a new version record to `version-info.xml`
- Update the current version number in `src/services/updateService.ts`

### 2. Manual Update (Not Recommended)

If you need to manually update `version-info.xml`, follow this format:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<versions>
  <version>
    <number>0.1.3</number>
    <releaseDate>2025-01-03</releaseDate>
    <changelog>
      <item>Fix search functionality bug</item>
      <item>Add new filter options</item>
      <item>Optimize UI responsiveness</item>
    </changelog>
    <downloadUrl>https://github.com/AmintaCCCP/GithubStarsManager/releases/download/v0.1.3/github-stars-manager-0.1.3.dmg</downloadUrl>
  </version>
</versions>
```

### 3. Release Process

1. Use `npm run update-version` to update version information
2. Commit changes to the Git repository:
   ```bash
   git add .
   git commit -m "chore: bump version to v0.1.3"
   git push origin main
   ```
3. Create the corresponding Release on GitHub and upload the built installation packages
4. Ensure the download link matches `downloadUrl` in the XML

## XML File Format Reference

- `number`: Version number, in x.y.z format
- `releaseDate`: Release date, in YYYY-MM-DD format
- `changelog`: Changelog, where each `<item>` represents an update item
- `downloadUrl`: Download URL for the corresponding release

## Notes

1. Version numbers must follow Semantic Versioning (SemVer)
2. When releasing a new version, verify that the download link in the GitHub Release is accessible
3. The XML file is fetched over the network by the application; ensure valid XML formatting
4. It is recommended to test the update check feature locally before releasing