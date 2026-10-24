FROM clamav/clamav:stable

# The clamav/clamav:stable image ships with the signature databases baked in,
# so each isolated scan container starts without downloading definitions.
USER root

RUN apk add --no-cache python3 py3-pip \
    && pip3 install --no-cache-dir --break-system-packages \
    azure-identity==1.19.0 azure-storage-blob==12.24.0

# Rebuild regularly; each image carries a fresh signature snapshot.
RUN freshclam --stdout

COPY scan.py /opt/scan.py

ENTRYPOINT ["python3", "/opt/scan.py"]
