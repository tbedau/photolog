import os
import io
from uuid import uuid4
from PIL import Image as PILImage, UnidentifiedImageError, ExifTags
from fastapi import HTTPException, UploadFile
from .config import get_settings

settings = get_settings()

async def process_and_save_image(file: UploadFile, user_id: int, content_type: str = None) -> str:
    """
    Processes and saves an uploaded image file, ensuring it meets size, format, and dimension restrictions.

    Args:
        file (UploadFile): The uploaded image file.
        user_id (int): The ID of the user uploading the file.

    Returns:
        str: The filename of the saved image.

    Raises:
        HTTPException: If the file is too large, has an unsupported format, or cannot be processed.
    """
    
    # Read file content into memory
    image_data = await file.read()

    # Validate file size
    if len(image_data) > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Max size is 10 MB.")

    # Use the provided content type or fall back to the file's content_type
    actual_content_type = content_type or file.content_type

    # Validate file format
    if actual_content_type not in ["image/jpeg", "image/jpg", "image/png", "image/tiff"]:
        raise HTTPException(status_code=400, detail="Unsupported file format. Only JPEG, PNG, and TIFF images are allowed.")


    # Generate a unique filename for storage
    filename = f"{uuid4().hex}_{user_id}.jpg"  # Save all files as JPEG for consistency
    filepath = os.path.join(settings.UPLOAD_FOLDER, filename)

    try:
        # Open the image
        with PILImage.open(io.BytesIO(image_data)) as img:
            # Apply EXIF orientation if present
            try:
                for orientation in ExifTags.TAGS.keys():
                    if ExifTags.TAGS[orientation] == 'Orientation':
                        break
                exif = img._getexif()
                if exif:
                    orientation_value = exif.get(orientation)
                    if orientation_value == 3:
                        img = img.rotate(180, expand=True)
                    elif orientation_value == 6:
                        img = img.rotate(270, expand=True)
                    elif orientation_value == 8:
                        img = img.rotate(90, expand=True)
            except (AttributeError, KeyError, IndexError):
                # Skip if there's no EXIF orientation data
                pass
            
            # Convert image to RGB if necessary (ensures consistency and JPEG compatibility)
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            
            # Resize image if it exceeds max dimensions
            if img.width > settings.MAX_DIMENSION or img.height > settings.MAX_DIMENSION:
                img.thumbnail((settings.MAX_DIMENSION, settings.MAX_DIMENSION))
            
            # Save the processed image as JPEG
            img.save(filepath, format="JPEG", quality=85, progressive=True)

    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="Error processing image. Unsupported or corrupted file.")
    except Exception as e:
        raise HTTPException(status_code=500, detail="An error occurred while processing the image.")

    return filename
