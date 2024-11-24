# Photolog

Photolog is a minimalist, responsive web application for sharing and viewing a personal collection of images. The original idea behind the app was to upload one image per day, functioning as a kind of visual diary, but this behavior is configurable. The app allows authenticated users to upload photos, while others can browse an infinite scroll of your curated gallery.

I am running an instance of Photolog at [https://photolog.tillmannbedau.de](https://photolog.tillmannbedau.de), where I share one photo per day from my analog archives and occasionally also upload recent images.

## Setup and Installation

1. **Clone the Repository:**

    ```sh
    git clone git@github.com:tbedau/photolog.git
    cd photolog
    ```

2. **Create a .env File:** In the root directory, create a `.env` file and set your secret key:

    ``` sh
    SECRET_KEY=your-secret-key
    ```

3. **Create a User:** Run the following command to create an initial user. You will be prompted to set a password:

    ```sh
    uv run cli.py create-user <USERNAME>
    ```

4. **Run the Development Server:** Start the application locally:

    ```sh
    uv run fastapi dev
    ```

5. **Start Uploading Photos:** Visit [http://127.0.0.1:8000/upload](http://127.0.0.1:8000/upload) to log in and start uploading photos.

6. **Configure the Application:** Customize the app behavior (e.g., upload limits, max dimensions) by editing app/config.py to fit your needs. Also edit HTML templates in the `templates/`folder to customize page headers and so on.

7. **Deploy the app:** The `Dockerfile` and `docker-compose.yml` can serve as a reference for containerized deployment.
